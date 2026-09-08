import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoordinatedWeleticSessionStorage } from "../../../../packages/shopify-app/app/coordinated-session-storage.server";
import { createMerchantAction } from "../../../../packages/shopify-app/app/merchant-action.server";
import { createMerchantAuthenticator } from "../../../../packages/shopify-app/app/merchant-authentication.server";
import { deserializeShopifySession } from "../../../../packages/shopify-app/app/session-properties.server";
import { onlineTokenExchangeFixture } from "../../../../packages/shopify-app/test-support/online-token-exchange";
import { verifyWeleticShopifyRequest } from "../../lib/weletic/shopify/service-auth";
import type {
  ShopifySessionMutationFence,
  ShopifySessionProperty,
} from "../../lib/weletic/shopify/session-contract";

const shop = "online-fixture.myshopify.com";
const id = `${shop}_123`;
function properties(): ShopifySessionProperty[] {
  return [
    ["id", id],
    ["shop", shop],
    ["state", ""],
    ["isOnline", true],
    ["userId", 123],
    ["accountOwner", false],
    ["collaborator", false],
    ["scope", "read_products,write_discounts"],
    ["associatedUserScope", "read_products"],
    ["accessToken", "synthetic-online-token"],
    ["expires", Date.now() + 60000],
  ];
}
function session() {
  return deserializeShopifySession(properties())!;
}
const binding = {
  appId: "online-client-test",
  shop,
  storeId: "synthetic-store",
  installationGeneration: "generation-1",
};

// Intercepted signed HTTP plus real SDK Session/storage, not SQL or login proof.
function gateway(persist = false) {
  const state = {
    generation: "generation-1",
    rejectRenew: false,
    cached: {
      properties: properties(),
      onlineBinding: binding,
      onlineDigest: "c".repeat(64),
    } as {
      properties: ShopifySessionProperty[];
      onlineBinding?: unknown;
      onlineDigest?: unknown;
    } | null,
    writes: [] as Array<{
      properties: ShopifySessionProperty[];
      onlineCoordination: ShopifySessionMutationFence;
    }>,
    snapshots: 0,
    deletes: [] as string[],
    merchantStatus: 200,
    stalledMerchant: false,
    releases: 0,
    merchantWrites: [] as Array<Record<string, unknown>>,
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = init?.body ? String(init.body) : "";
    expect(url.origin).toBe("https://session-gateway.invalid");
    expect(verifyWeleticShopifyRequest({ request, body })).toBe(true);
    if (request.method === "GET") {
      if (url.pathname.endsWith("coordination")) {
        state.snapshots++;
        return Response.json({
          properties: null,
          observed: {
            epoch: "0",
            revision: "0",
            sessionDigest: "a".repeat(64),
            credentialTokenHash: "b".repeat(64),
            installationGeneration: state.generation,
          },
        });
      }
      return Response.json({ sessions: state.cached ? [state.cached] : [] });
    }
    const data = JSON.parse(body);
    if (
      [
        "/api/internal/shopify/merchant/staff/grants",
        "/api/internal/shopify/merchant/staff/grants/list",
        "/api/internal/shopify/merchant/overview",
        "/api/internal/shopify/merchant/staff/export",
        "/api/internal/shopify/merchant/reviews/list",
        "/api/internal/shopify/merchant/reviews/moderate",
      ].includes(url.pathname)
    ) {
      state.merchantWrites.push(data);
      if (url.pathname.endsWith("/reviews/moderate"))
        return Response.json({
          reviewId: data.input.reviewId,
          auditId: "audit-1",
          version: 2,
          status: "hidden",
        });
      if (url.pathname === "/api/internal/shopify/merchant/reviews/list")
        return Response.json({ view: "reviews", items: [], nextCursor: null });
      if (url.pathname.endsWith("/list"))
        return Response.json({ grants: [], nextCursor: null });
      if (state.stalledMerchant) {
        // Listen to the actual fetch signal. Undici may collect the temporary
        // Request's derived controller after this mock returns its response.
        const signal = init?.signal;
        if (!signal) throw new Error("Expected merchant fetch deadline signal");
        return new Response(
          new ReadableStream({
            start(controller) {
              const abort = () =>
                controller.error(
                  new Error("Synthetic stalled response aborted"),
                );
              if (signal.aborted) abort();
              else signal.addEventListener("abort", abort, { once: true });
            },
          }),
        );
      }
      return Response.json(
        state.merchantStatus === 200
          ? { grant: { ...data.input, revision: 1 } }
          : { error: "access_denied" },
        { status: state.merchantStatus },
      );
    }
    if (url.pathname.endsWith("coordination")) {
      if (data.action === "acquire")
        return Response.json({
          lease: { token: data.token, epoch: "1", revision: "0" },
        });
      if (data.action === "release") {
        state.releases++;
        return Response.json({ released: true });
      }
      const stale =
        state.rejectRenew ||
        (data.observed &&
          data.observed.installationGeneration !== state.generation);
      return Response.json(
        stale ? { error: "stale_session" } : { renewed: true },
        { status: stale ? 409 : 200 },
      );
    }
    expect(url.pathname).toBe("/api/internal/shopify/sessions");
    if (request.method === "DELETE") {
      state.deletes.push(data.onlineDeletion.expectedPayloadDigest);
      if (!state.cached) return Response.json({ deleted: 0 });
      if (
        data.onlineDeletion.expectedPayloadDigest !== state.cached.onlineDigest
      )
        return Response.json({ error: "stale_session" }, { status: 409 });
      state.cached = null;
      return Response.json({ deleted: 1 });
    }
    state.writes.push(data);
    if (persist)
      state.cached = {
        properties: data.properties,
        onlineBinding: binding,
        onlineDigest: "d".repeat(64),
      };
    return Response.json({ stored: true });
  });
  return { state, fetcher };
}
function tokenResponse(user: Record<string, unknown> = {}) {
  return {
    access_token: "synthetic-online-token",
    expires_in: 3600,
    associated_user_scope: "read_products",
    associated_user: {
      id: 123,
      account_owner: false,
      collaborator: false,
      ...user,
    },
  };
}
async function exchange(
  storage: CoordinatedWeleticSessionStorage,
  payload: Record<string, unknown> = tokenResponse(),
  beforeResponse?: () => void,
) {
  return storage.tokenRequest(
    `https://${shop}/admin/oauth/access_token`,
    {},
    async () => {
      beforeResponse?.();
      return Response.json(payload);
    },
  );
}

describe("online session original-installation client", () => {
  beforeEach(() => {
    vi.stubEnv("SHOPIFY_API_KEY", binding.appId);
    vi.stubEnv("WELETIC_API_URL", "https://session-gateway.invalid");
    vi.stubEnv(
      "WELETIC_SHOPIFY_SERVICE_SECRET",
      "synthetic-online-client-secret-at-least-32-characters",
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    "valid",
    "wrong-signature",
    "wrong-audience",
    "expired",
    "missing-expiry",
    "wrong-issuer",
    "destination-path",
    "unsafe-user",
    "provider-user-mismatch",
    "provider-denied",
    "missing-bearer",
    "valid-action",
    "valid-list-action",
    "valid-overview-action",
    "valid-export-action",
    "valid-reviews-action",
    "valid-moderation-action",
    "action-denied",
    "action-stalled",
    "future-issued",
    "future-not-before",
    "missing-issued",
    "missing-not-before",
    "provider-owner-type",
    "provider-collaborator-type",
  ])(
    "binds browser authentication to the fresh provider identity: %s",
    async (kind) => {
      const fixture = gateway(true);
      if (kind === "action-denied") fixture.state.merchantStatus = 403;
      if (kind === "action-stalled") {
        fixture.state.stalledMerchant = true;
        const timeout = AbortSignal.timeout.bind(AbortSignal);
        vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
          timeout(Math.min(ms, 25)),
        );
      }
      vi.stubGlobal("fetch", fixture.fetcher);
      const storage = new CoordinatedWeleticSessionStorage();
      const secret = "synthetic-merchant-sdk-secret-at-least-32-characters";
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss:
          kind === "wrong-issuer"
            ? "https://other.myshopify.com/admin"
            : `https://${shop}/admin`,
        dest: `https://${shop}${kind === "destination-path" ? "/other" : ""}`,
        sub: kind === "unsafe-user" ? "9007199254740992" : "123",
        aud: kind === "wrong-audience" ? "other-app" : binding.appId,
        iat:
          kind === "missing-issued"
            ? undefined
            : kind === "future-issued"
              ? now + 30
              : now - 30,
        nbf:
          kind === "missing-not-before"
            ? undefined
            : kind === "future-not-before"
              ? now + 30
              : now - 30,
        exp:
          kind === "missing-expiry"
            ? undefined
            : kind === "expired"
              ? now - 20
              : now + 60,
      };
      const encoded = [
        Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
          "base64url",
        ),
        Buffer.from(JSON.stringify(claims)).toString("base64url"),
      ].join(".");
      const jwt = `${encoded}.${createHmac(
        "sha256",
        kind === "wrong-signature" ? "wrong-secret" : secret,
      )
        .update(encoded)
        .digest("base64url")}`;
      const transport = vi.fn<typeof fetch>(async (input, init) => {
        expect(new URL(String(input)).hostname).toBe(shop);
        expect(JSON.parse(String(init?.body))).toMatchObject({
          requested_token_type:
            "urn:shopify:params:oauth:token-type:online-access-token",
          subject_token: jwt,
        });
        if (kind === "provider-denied")
          return Response.json({ error: "denied" }, { status: 403 });
        return Response.json({
          ...tokenResponse(
            kind === "provider-user-mismatch"
              ? { id: 456 }
              : kind === "provider-owner-type"
                ? { account_owner: "false" }
                : kind === "provider-collaborator-type"
                  ? { collaborator: "false" }
                  : {},
          ),
          scope: "read_products",
        });
      });
      const sdk = onlineTokenExchangeFixture({
        storage,
        apiKey: binding.appId,
        apiSecretKey: secret,
        transport,
      });
      const authenticate = createMerchantAuthenticator({
        storage,
        sdk: sdk.sdk,
      });
      const callback = vi.fn(
        async ({ actor }: { actor: { shop: string; userId: string } }) => {
          expect(actor.shop).toBe(shop);
          expect(actor.userId).toBe("123");
          return "authenticated";
        },
      );
      try {
        const request = new Request(
          "https://app.invalid/merchant?shop=ignored.myshopify.com",
          {
            headers:
              kind === "missing-bearer"
                ? {}
                : { Authorization: `Bearer ${jwt}` },
          },
        );
        if (
          [
            "valid-action",
            "valid-list-action",
            "valid-overview-action",
            "valid-export-action",
            "valid-reviews-action",
            "valid-moderation-action",
            "action-denied",
            "action-stalled",
          ].includes(kind)
        ) {
          const handle = createMerchantAction(
            authenticate,
            kind === "valid-moderation-action"
              ? "moderate-review"
              : kind === "valid-reviews-action"
                ? "reviews"
                : kind === "valid-export-action"
                  ? "export"
                  : kind === "valid-overview-action"
                    ? "overview"
                    : kind === "valid-list-action"
                      ? "list"
                      : "replace",
          );
          const input =
            kind === "valid-moderation-action"
              ? {
                  reviewId: "review-1",
                  version: 1,
                  status: "hidden",
                  reason: "spam",
                }
              : kind === "valid-reviews-action"
                ? { view: "reviews", limit: 25, rating: 1 }
                : kind === "valid-export-action"
                  ? { kind: "actions", limit: 25 }
                  : kind === "valid-overview-action"
                    ? {}
                    : kind === "valid-list-action"
                      ? { limit: 25 }
                      : {
                          userId: "456",
                          expectedRevision: 0,
                          permissions: ["reviews.read"],
                        };
          const result = await handle(
            new Request(request.url, {
              method: "POST",
              headers: request.headers,
              body: JSON.stringify(input),
            }),
          );
          expect(result.status).toBe(
            [
              "valid-action",
              "valid-list-action",
              "valid-overview-action",
              "valid-export-action",
              "valid-reviews-action",
              "valid-moderation-action",
            ].includes(kind)
              ? 200
              : kind === "action-stalled"
                ? 503
                : 403,
          );
          expect(result.headers.get("Cache-Control")).toBe("private, no-store");
          expect(fixture.state.merchantWrites).toHaveLength(1);
          expect(fixture.state.merchantWrites[0]).toMatchObject({
            actor: { shop, userId: "123" },
            input,
          });
          expect(transport).toHaveBeenCalledTimes(1);
          expect(fixture.state.releases).toBe(1);
          if (kind === "action-denied")
            expect(await result.json()).toEqual({ error: "access_denied" });
        } else if (kind === "valid") {
          expect(await authenticate(request, callback)).toBe("authenticated");
          expect(transport).toHaveBeenCalledTimes(1);
          expect(callback).toHaveBeenCalledTimes(1);
          expect(fixture.state.writes).toHaveLength(1);
        } else {
          const failure = await authenticate(request, callback).catch(
            (error: unknown) => error,
          );
          expect(failure).toBeInstanceOf(Error);
          if (!(failure instanceof Error))
            throw new Error("Expected sanitized error");
          expect(failure.message).not.toContain(jwt);
          expect(failure.message).not.toContain(secret);
          expect(callback).not.toHaveBeenCalled();
          expect(fixture.state.writes).toHaveLength(0);
          expect(transport).toHaveBeenCalledTimes(
            [
              "provider-user-mismatch",
              "provider-denied",
              "provider-owner-type",
              "provider-collaborator-type",
            ].includes(kind)
              ? 1
              : 0,
          );
        }
      } finally {
        sdk.restoreTransport();
      }
    },
  );

  it.each(["valid", "wrong-signature", "wrong-audience", "expired"])(
    "exercises the real SDK token exchange with a %s JWT",
    async (kind) => {
      const fixture = gateway();
      vi.stubGlobal("fetch", fixture.fetcher);
      const storage = new CoordinatedWeleticSessionStorage();
      const secret = "synthetic-sdk-jwt-secret-at-least-32-characters";
      const timestamp = Math.floor(Date.now() / 1000);
      const header = Buffer.from(
        JSON.stringify({ alg: "HS256", typ: "JWT" }),
      ).toString("base64url");
      const claims = Buffer.from(
        JSON.stringify({
          iss: `https://${shop}/admin`,
          dest: `https://${shop}`,
          sub: "123",
          aud: kind === "wrong-audience" ? "different-app" : binding.appId,
          iat: timestamp - 60,
          nbf: timestamp - 60,
          exp: kind === "expired" ? timestamp - 30 : timestamp + 60,
        }),
      ).toString("base64url");
      const unsigned = `${header}.${claims}`;
      const jwt = `${unsigned}.${createHmac(
        "sha256",
        kind === "wrong-signature" ? "wrong-synthetic-secret" : secret,
      )
        .update(unsigned)
        .digest("base64url")}`;
      const transport = vi.fn<typeof fetch>(async (input, init) => {
        expect(
          new URL(
            typeof input === "string" || input instanceof URL
              ? input
              : input.url,
          ).hostname,
        ).toBe(shop);
        expect(JSON.parse(String(init?.body))).toMatchObject({
          client_id: binding.appId,
          requested_token_type:
            "urn:shopify:params:oauth:token-type:online-access-token",
          subject_token: jwt,
        });
        return Response.json({
          ...tokenResponse(),
          scope: "read_products,write_discounts",
        });
      });
      const sdk = onlineTokenExchangeFixture({
        storage,
        apiKey: binding.appId,
        apiSecretKey: secret,
        transport,
      });
      try {
        const operation = storage.runOperation(async () => {
          const { session } = await sdk.exchange(shop, jwt);
          expect(session.isOnline).toBe(true);
          expect(session.id).toBe(id);
          expect(session.onlineAccessInfo?.associated_user_scope).toBe(
            "read_products",
          );
          expect(session.onlineAccessInfo?.associated_user.account_owner).toBe(
            false,
          );
          await storage.storeSession(session);
          fixture.state.cached = {
            properties: fixture.state.writes[0].properties,
            onlineBinding: binding,
            onlineDigest: "d".repeat(64),
          };
          const actor = await storage.mintMerchantActor(session);
          expect(actor).toMatchObject({
            ...binding,
            version: 1,
            userId: "123",
            sessionId: id,
            sessionDigest: "d".repeat(64),
          });
          expect(actor).not.toHaveProperty("accountOwner");
          expect(actor).not.toHaveProperty("accessToken");
          expect(actor.requestId).toMatch(/^[a-f0-9]{64}$/);
          await expect(storage.mintMerchantActor(session)).rejects.toThrow(
            "Fresh Shopify authentication",
          );
          return true;
        });
        if (kind === "valid") {
          expect(await operation).toBe(true);
          expect(transport).toHaveBeenCalledTimes(1);
          expect(fixture.state.writes).toHaveLength(1);
        } else {
          await expect(operation).rejects.toThrow();
          expect(transport).not.toHaveBeenCalled();
          expect(fixture.state.snapshots).toBe(0);
          expect(fixture.state.writes).toHaveLength(0);
        }
      } finally {
        sdk.restoreTransport();
      }
    },
  );

  it("never mints authority from a cached session, even after resaving it", async () => {
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    const storage = new CoordinatedWeleticSessionStorage();
    await storage.runOperation(async () => {
      const cached = await storage.loadSession(id);
      expect(cached).toBeDefined();
      await expect(storage.mintMerchantActor(cached!)).rejects.toThrow(
        "Fresh Shopify authentication",
      );
      await storage.storeSession(cached!);
      await expect(storage.mintMerchantActor(cached!)).rejects.toThrow(
        "Fresh Shopify authentication",
      );
    });
  });

  it("rejects changed persistence and cannot reuse the failed mint", async () => {
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    const storage = new CoordinatedWeleticSessionStorage();
    await storage.runOperation(async () => {
      await storage.loadSession(`offline_${shop}`);
      await exchange(storage);
      const online = session();
      await storage.storeSession(online);
      fixture.state.cached = {
        properties: fixture.state.writes[0].properties.map(([key, value]) => [
          key,
          key === "accountOwner" ? true : value,
        ]),
        onlineBinding: binding,
        onlineDigest: "d".repeat(64),
      };
      await expect(storage.mintMerchantActor(online)).rejects.toThrow(
        "Online Shopify session changed",
      );
      fixture.state.cached.properties = fixture.state.writes[0].properties;
      await expect(storage.mintMerchantActor(online)).rejects.toThrow(
        "Fresh Shopify authentication",
      );
    });
  });

  it("cannot mint after its originating operation closes", async () => {
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    const storage = new CoordinatedWeleticSessionStorage();
    const online = await storage.runOperation(async () => {
      await storage.loadSession(`offline_${shop}`);
      await exchange(storage);
      const value = session();
      await storage.storeSession(value);
      return value;
    });
    await expect(storage.mintMerchantActor(online)).rejects.toThrow(
      "Fresh Shopify authentication",
    );
  });

  it("publishes the original observation from before provider I/O", async () => {
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    const storage = new CoordinatedWeleticSessionStorage();
    await storage.runOperation(async () => {
      const response = await exchange(storage);
      expect((await response.json()).associated_user.account_owner).toBe(false);
      expect(await storage.storeSession(session())).toBe(true);
    });
    expect(fixture.state.snapshots).toBe(1);
    expect(fixture.state.writes).toHaveLength(1);
    expect(
      fixture.state.writes[0].onlineCoordination.observed
        .installationGeneration,
    ).toBe("generation-1");
  });
  it("does not capture a replacement installation after a delayed exchange", async () => {
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    const storage = new CoordinatedWeleticSessionStorage();
    await expect(
      storage.runOperation(async () => {
        await exchange(storage, tokenResponse(), () => {
          fixture.state.generation = "generation-2";
        });
        await storage.storeSession(session());
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fixture.state.snapshots).toBe(1);
    expect(fixture.state.writes).toHaveLength(0);
  });
  it.each([
    { account_owner: "false" },
    { collaborator: "false" },
    { id: "123" },
  ])(
    "rejects raw malformed identity before SDK hydration: %j",
    async (user) => {
      const fixture = gateway();
      vi.stubGlobal("fetch", fixture.fetcher);
      const storage = new CoordinatedWeleticSessionStorage();
      await expect(
        storage.runOperation(() => exchange(storage, tokenResponse(user))),
      ).rejects.toMatchObject({ status: 503 });
      expect(fixture.state.writes).toHaveLength(0);
    },
  );
  it("rejects an invented session even after observing a current installation", async () => {
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    fixture.state.cached = null;
    const storage = new CoordinatedWeleticSessionStorage();
    await storage.runOperation(async () => {
      expect(await storage.loadSession(id)).toBeUndefined();
      await expect(storage.storeSession(session())).rejects.toMatchObject({
        status: 409,
      });
    });
    expect(fixture.state.writes).toHaveLength(0);
  });
  it("does not let SDK object mutation widen the provider permission evidence", async () => {
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    const storage = new CoordinatedWeleticSessionStorage();
    await storage.runOperation(async () => {
      await exchange(storage);
      const changed = session();
      changed.onlineAccessInfo!.associated_user.account_owner = true;
      await expect(storage.storeSession(changed)).rejects.toMatchObject({
        status: 409,
      });
    });
    expect(fixture.state.writes).toHaveLength(0);
  });
  it.each(["legacy", "replacement", "different-app", "expired"])(
    "returns a cache miss for %s evidence",
    async (kind) => {
      const fixture = gateway();
      vi.stubGlobal("fetch", fixture.fetcher);
      if (kind === "legacy")
        fixture.state.cached = { properties: properties() };
      if (kind === "replacement") fixture.state.generation = "generation-2";
      if (kind === "different-app")
        fixture.state.cached!.onlineBinding = {
          ...binding,
          appId: "other-app",
        };
      if (kind === "expired")
        fixture.state.cached!.properties = properties().map(([key, value]) => [
          key,
          key === "expires" ? Date.now() - 1000 : value,
        ]);
      const storage = new CoordinatedWeleticSessionStorage();
      await storage.runOperation(async () => {
        expect(await storage.loadSession(id)).toBeUndefined();
      });
      expect(fixture.state.writes).toHaveLength(0);
    },
  );
  it.each([0, -1, "3600", 1.1, Number.MAX_SAFE_INTEGER, null])(
    "rejects invalid raw token lifetime %j",
    async (expires_in) => {
      const fixture = gateway();
      vi.stubGlobal("fetch", fixture.fetcher);
      const storage = new CoordinatedWeleticSessionStorage();
      await expect(
        storage.runOperation(() =>
          exchange(storage, { ...tokenResponse(), expires_in }),
        ),
      ).rejects.toMatchObject({ status: 503 });
      expect(fixture.state.writes).toHaveLength(0);
    },
  );

  it("clamps a new SDK session to the lifetime captured before provider I/O", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2000000000000);
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    const storage = new CoordinatedWeleticSessionStorage();
    await storage.runOperation(async () => {
      await exchange(storage, { ...tokenResponse(), expires_in: 1 });
      expect(await storage.storeSession(session())).toBe(true);
    });
    expect(
      fixture.state.writes[0].properties.find(
        ([key]) => key === "expires",
      )?.[1],
    ).toBe(2000000001000);
  });

  it("rejects extending a loaded session's original expiry", async () => {
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    const storage = new CoordinatedWeleticSessionStorage();
    await storage.runOperation(async () => {
      const loaded = (await storage.loadSession(id))!;
      loaded.expires = new Date(loaded.expires!.getTime() + 1000);
      await expect(storage.storeSession(loaded)).rejects.toMatchObject({
        status: 409,
      });
    });
    expect(fixture.state.writes).toHaveLength(0);
  });

  it("does not let a retained object overwrite a newer session in another operation", async () => {
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    const storage = new CoordinatedWeleticSessionStorage();
    const old = (await storage.runOperation(() => storage.loadSession(id)))!;
    fixture.state.cached!.properties = properties().map(([key, value]) => [
      key,
      key === "accessToken" ? "synthetic-replacement-token" : value,
    ]);
    await storage.runOperation(async () => {
      const replacement = (await storage.loadSession(id))!;
      expect(await storage.storeSession(replacement)).toBe(true);
    });
    await storage.runOperation(async () => {
      await storage.loadSession(id);
      await expect(storage.storeSession(old)).rejects.toMatchObject({
        status: 409,
      });
    });
    expect(fixture.state.writes).toHaveLength(1);
    expect(
      fixture.state.writes[0].properties.find(
        ([key]) => key === "accessToken",
      )?.[1],
    ).toBe("synthetic-replacement-token");
  });

  it("rejects a retained object after another publication in the same operation", async () => {
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    const storage = new CoordinatedWeleticSessionStorage();
    await storage.runOperation(async () => {
      const old = (await storage.loadSession(id))!;
      await exchange(storage);
      expect(await storage.storeSession(session())).toBe(true);
      await expect(storage.storeSession(old)).rejects.toMatchObject({
        status: 409,
      });
    });
    expect(fixture.state.writes).toHaveLength(1);
  });

  it("does not resurrect a deleted session in the same operation", async () => {
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    const storage = new CoordinatedWeleticSessionStorage();
    await storage.runOperation(async () => {
      const old = (await storage.loadSession(id))!;
      await storage.deleteSession(id);
      await expect(storage.storeSession(old)).rejects.toMatchObject({
        status: 409,
      });
    });
    expect(fixture.state.cached).toBeNull();
    expect(fixture.state.writes).toHaveLength(0);
  });

  it("allows only one competing same-operation cached publication", async () => {
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    const storage = new CoordinatedWeleticSessionStorage();
    await storage.runOperation(async () => {
      const a = (await storage.loadSession(id))!;
      const b = (await storage.loadSession(id))!;
      const results = await Promise.allSettled([
        storage.storeSession(a),
        storage.storeSession(b),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
    });
    expect(fixture.state.writes).toHaveLength(1);
  });

  it("deletes only the loaded online version and supports an idempotent retry", async () => {
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    const storage = new CoordinatedWeleticSessionStorage();
    await storage.runOperation(async () => {
      await storage.loadSession(id);
      expect(await storage.deleteSession(id)).toBe(true);
      expect(await storage.deleteSession(id)).toBe(true);
    });
    expect(fixture.state.deletes).toEqual(["c".repeat(64), "c".repeat(64)]);
    expect(fixture.state.cached).toBeNull();
  });

  it("does not retarget a delayed delete after reloading a replacement version", async () => {
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    const storage = new CoordinatedWeleticSessionStorage();
    await expect(
      storage.runOperation(async () => {
        await storage.loadSession(id);
        fixture.state.cached!.onlineDigest = "d".repeat(64);
        await storage.loadSession(id);
        await storage.deleteSession(id);
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fixture.state.deletes).toEqual(["c".repeat(64)]);
    expect(fixture.state.cached?.onlineDigest).toBe("d".repeat(64));
  });

  it("cannot delete without loading an original bound online version", async () => {
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    fixture.state.cached = null;
    const storage = new CoordinatedWeleticSessionStorage();
    await storage.runOperation(async () => {
      await storage.loadSession(id);
      await expect(storage.deleteSession(id)).rejects.toMatchObject({
        status: 409,
      });
    });
    expect(fixture.state.deletes).toHaveLength(0);
  });

  it("loads a bound session under its original operation, but rejects later writes outside it", async () => {
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    const storage = new CoordinatedWeleticSessionStorage();
    const loaded = await storage.runOperation(() => storage.loadSession(id));
    expect(loaded?.onlineAccessInfo?.associated_user_scope).toBe(
      "read_products",
    );
    await expect(storage.storeSession(loaded!)).rejects.toMatchObject({
      status: 409,
    });
    expect(await storage.loadSession(id)).toBeUndefined();
    expect(fixture.state.writes).toHaveLength(0);
  });
});
