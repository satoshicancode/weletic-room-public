import { Session } from "@shopify/shopify-api";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import type {
  ShopifySessionLeaseProof,
  ShopifySessionMutationFence,
  ShopifySessionObservation,
  ShopifySessionSnapshot,
} from "../../../apps/web/lib/weletic/shopify/session-contract";
import {
  bindShopifyOnlineSession,
  shopifyOnlineSessionBindingSchema,
} from "../../../apps/web/lib/weletic/shopify/session-online-binding";
import { readOnlineSessionEvidence } from "../../../apps/web/lib/weletic/shopify/session-online-evidence";
import {
  isFreshShopifyMerchantActor,
  shopifyMerchantActorEnvelopeSchema,
} from "../../../apps/web/lib/weletic/shopify/staff-contract";
import {
  deserializeShopifySession,
  serializeShopifySession,
} from "./session-properties.server";
import {
  requireEnv,
  weleticApiJson,
  WeleticGatewayError,
} from "./weletic-api.server";
import {
  fetchCurrentAppInstallationScopes,
  WeleticSessionStorage,
} from "./weletic-session-storage.server";

const COORDINATION_PATH = "/api/internal/shopify/sessions/coordination";
const MUTATION_PATH = "/api/internal/shopify/sessions/coordinated";
const REQUEST_TIMEOUT_MS = 8_000;
const HEARTBEAT_MS = 15_000;
const LOCAL_OWNERSHIP_MS = 45_000;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
async function consumeTokenResponse(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing token response body");
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    while (true) {
      if (signal.aborted) throw new Error("Token response deadline exceeded");
      const chunk = await reader.read();
      if (signal.aborted) throw new Error("Token response deadline exceeded");
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_TOKEN_RESPONSE_BYTES)
        throw new Error("Token response too large");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const parsed: unknown = JSON.parse(text);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (response.ok &&
        (!("access_token" in parsed) ||
          typeof parsed.access_token !== "string" ||
          !parsed.access_token))
    )
      throw new Error("Invalid token response");
    return {
      payload: parsed as Record<string, unknown>,
      response: new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    };
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}
const copyObservation = (value: ShopifySessionObservation) => ({ ...value });
function sameObservation(
  a: ShopifySessionObservation,
  b: ShopifySessionObservation,
) {
  return (
    a.revision === b.revision &&
    a.sessionDigest === b.sessionDigest &&
    a.installationGeneration === b.installationGeneration &&
    a.credentialTokenHash === b.credentialTokenHash
  );
}
function nextCounter(value: string) {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(value))
    throw new WeleticGatewayError("Invalid session acknowledgement", 503);
  return String(BigInt(value) + BigInt(1));
}
type Entry = {
  shop: string;
  snapshot: ShopifySessionSnapshot;
  lease: ShopifySessionLeaseProof;
  lost: boolean;
  localDeadline: number;
  timer?: ReturnType<typeof setInterval>;
  renewal?: Promise<void>;
  onlineVersions: Map<string, symbol>;
  onlineMutationInFlight: boolean;
  onlineDeletes: Map<
    string,
    { digest: string; observed: ShopifySessionObservation }
  >;
  onlineExchanges: Map<
    string,
    {
      observed: ShopifySessionObservation;
      evidence: NonNullable<ReturnType<typeof readOnlineSessionEvidence>>;
      expiresAt: number;
      authenticatedAt: number;
      actorIssued: boolean;
      version?: symbol;
    }
  >;
};
type Operation = { pending: Map<string, Promise<Entry>>; closed: boolean };

function offlineShop(id: string) {
  if (!id.startsWith("offline_")) return null;
  const shop = id.slice("offline_".length);
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    throw new WeleticGatewayError("Invalid offline session identifier", 400);
  }
  return shop;
}

/** SDK operation context carries observations when refresh returns a NEW Session. */
export class CoordinatedWeleticSessionStorage extends WeleticSessionStorage {
  private readonly operations = new AsyncLocalStorage<Operation>();
  private readonly onlineObservations = new WeakMap<
    Session,
    {
      observed: ShopifySessionObservation;
      evidence: NonNullable<ReturnType<typeof readOnlineSessionEvidence>>;
      tokenDigest: string;
      expiresAt: number;
      authenticatedAt?: number;
      operation: Operation;
      version?: symbol;
    }
  >();
  private readonly observations = new WeakMap<
    Session,
    ShopifySessionObservation
  >();

  /** Background work must carry the generation captured when it was queued.
   * Acquire the same original observation as interactive auth BEFORE SDK I/O.
   * This never creates an installation or adopts its current generation.
   */
  async runInstalledOperation<T>(
    shop: string,
    generation: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (
      offlineShop(`offline_${shop}`) !== shop ||
      typeof generation !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(generation)
    )
      throw new WeleticGatewayError("Invalid Shopify installation scope", 400);
    return this.runOperation(async () => {
      const entry = await this.entry(shop);
      this.assertOwned(entry);
      if (
        entry.snapshot.observed.installationGeneration !== generation ||
        !entry.snapshot.observed.credentialTokenHash ||
        !/^[a-f0-9]{64}$/.test(entry.snapshot.observed.credentialTokenHash)
      )
        throw new WeleticGatewayError(
          "Shopify installation generation changed",
          409,
        );
      try {
        const result = await operation();
        await this.renew(entry, true);
        this.assertOwned(entry);
        return result;
      } catch (error) {
        // A missing-session result is scoped to this original installation,
        // not permission for a delayed worker to alert a replacement install.
        await this.renew(entry, true);
        this.assertOwned(entry);
        throw error;
      }
    });
  }

  async runOperation<T>(operation: () => Promise<T>): Promise<T> {
    const existing = this.operations.getStore();
    if (existing && !existing.closed) return operation();
    const context: Operation = { pending: new Map(), closed: false };
    return this.operations.run(context, async () => {
      try {
        const result = await operation();
        for (const entry of await Promise.all(context.pending.values()))
          this.assertOwned(entry);
        return result;
      } finally {
        context.closed = true;
        const entries = await Promise.allSettled(context.pending.values());
        await Promise.all(
          entries.map(async (result) => {
            if (result.status !== "fulfilled") return;
            const entry = result.value;
            clearInterval(entry.timer);
            await entry.renewal;
            // Ambiguous release cannot switch transports or reuse ownership. The
            // database deadline recovers it; mutation errors must remain primary.
            try {
              await this.coordinate({
                action: "release",
                shop: entry.shop,
                lease: entry.lease,
              });
            } catch {
              /* Ownership expires; never mask the operation's error. */
            }
          }),
        );
      }
    });
  }

  private coordinate<T>(body: unknown) {
    return weleticApiJson<T>(COORDINATION_PATH, {
      method: "POST",
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  private snapshot(shop: string) {
    return weleticApiJson<ShopifySessionSnapshot>(
      `${COORDINATION_PATH}?shop=${encodeURIComponent(shop)}`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
  }

  private assertOwned(entry: Entry) {
    if (entry.lost || performance.now() >= entry.localDeadline)
      throw new WeleticGatewayError("Shopify session ownership was lost", 409);
  }

  private async renew(entry: Entry, fresh = false): Promise<void> {
    if (entry.renewal) {
      await entry.renewal;
      if (!fresh) return;
    }
    this.assertOwned(entry);
    const started = performance.now();
    entry.renewal = this.coordinate<{ renewed: true }>({
      action: "renew",
      shop: entry.shop,
      lease: entry.lease,
      // Heartbeats may overlap our own publication. Fresh boundary checks
      // wait for any heartbeat, then validate the exact original observation.
      ...(fresh ? { observed: copyObservation(entry.snapshot.observed) } : {}),
    })
      .then((result) => {
        if (result.renewed !== true)
          throw new Error("Missing renewal acknowledgement");
        entry.localDeadline = started + LOCAL_OWNERSHIP_MS;
      })
      .catch(() => {
        entry.lost = true;
      })
      .finally(() => {
        entry.renewal = undefined;
      });
    return entry.renewal;
  }

  /** Called only by the SDK transport, after its token/callback validation.
   * The original snapshot is captured BEFORE OAuth or refresh network I/O.
   */
  async tokenRequest(
    input: Parameters<typeof fetch>[0],
    init: RequestInit | undefined,
    transport: typeof fetch,
  ): Promise<Response> {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const shop = offlineShop(`offline_${url.hostname}`);
    if (
      !shop ||
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password
    )
      throw new WeleticGatewayError("Invalid Shopify token endpoint", 400);
    const entry = await this.entry(shop);
    if (entry.onlineMutationInFlight)
      throw new WeleticGatewayError("Online session mutation in progress", 409);
    await this.renew(entry, true);
    this.assertOwned(entry);
    const upstreamSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, TOKEN_REQUEST_TIMEOUT_MS);
    if (upstreamSignal?.aborted) abort();
    else upstreamSignal?.addEventListener("abort", abort, { once: true });
    try {
      const original = copyObservation(entry.snapshot.observed);
      const requestedAt = Date.now();
      const onlineVersions = new Map(entry.onlineVersions);
      const result = await transport(input, {
        ...init,
        signal: controller.signal,
      });
      // fetch() resolves at headers. Bound and validate the complete body here
      // so malformed, truncated or timed-out responses poison the same lease.
      const consumed = await consumeTokenResponse(result, controller.signal);
      this.assertOwned(entry);
      if (result.ok && "associated_user" in consumed.payload) {
        const user = consumed.payload.associated_user;
        if (!user || typeof user !== "object" || Array.isArray(user))
          throw new Error("Invalid online identity response");
        const values = user as Record<string, unknown>;
        if (
          typeof values.id !== "number" ||
          typeof values.account_owner !== "boolean" ||
          typeof values.collaborator !== "boolean" ||
          typeof consumed.payload.associated_user_scope !== "string"
        )
          throw new Error("Invalid online identity response");
        const evidence = readOnlineSessionEvidence([
          ["isOnline", true],
          ["userId", values.id],
          ["accountOwner", values.account_owner],
          ["collaborator", values.collaborator],
          ["associatedUserScope", consumed.payload.associated_user_scope],
        ]);
        if (
          !evidence ||
          !original.installationGeneration ||
          !original.credentialTokenHash
        )
          throw new Error(
            "Online exchange lacks an active original installation",
          );
        const token = consumed.payload.access_token;
        if (typeof token !== "string") throw new Error("Missing online token");
        const lifetime = consumed.payload.expires_in;
        if (
          typeof lifetime !== "number" ||
          !Number.isSafeInteger(lifetime) ||
          lifetime <= 0
        )
          throw new Error("Invalid online token lifetime");
        const expiresAt = requestedAt + lifetime * 1000;
        if (!Number.isSafeInteger(expiresAt) || expiresAt > 8640000000000000)
          throw new Error("Invalid online token expiry");
        const digest = createHash("sha256").update(token).digest("hex");
        const prior = entry.onlineExchanges.get(digest);
        if (
          prior &&
          (!sameObservation(prior.observed, original) ||
            JSON.stringify(prior.evidence) !== JSON.stringify(evidence))
        )
          throw new Error("Ambiguous online exchange evidence");
        entry.onlineExchanges.set(digest, {
          observed: original,
          evidence,
          expiresAt: Math.min(expiresAt, prior?.expiresAt ?? expiresAt),
          authenticatedAt: requestedAt,
          actorIssued: false,
          version: onlineVersions.get(`${shop}_${evidence.userId}`),
        });
      }
      return consumed.response;
    } catch {
      // An uncertain exchange must not be retried by this operation.
      entry.lost = true;
      throw new WeleticGatewayError("Shopify token exchange unavailable", 503);
    } finally {
      clearTimeout(timer);
      upstreamSignal?.removeEventListener("abort", abort);
    }
  }

  private async acquire(shop: string): Promise<Entry> {
    const snapshot = await this.snapshot(shop);
    const token = randomBytes(32).toString("hex");
    const started = performance.now();
    const { lease } = await this.coordinate<{
      lease: ShopifySessionLeaseProof;
    }>({
      action: "acquire",
      shop,
      token,
      observed: snapshot.observed,
    });
    if (
      !lease ||
      lease.token !== token ||
      lease.revision !== snapshot.observed.revision ||
      lease.epoch !== nextCounter(snapshot.observed.epoch)
    ) {
      throw new WeleticGatewayError(
        "Session acquisition was not acknowledged",
        503,
      );
    }
    const entry: Entry = {
      shop,
      snapshot,
      lease,
      lost: false,
      localDeadline: started + LOCAL_OWNERSHIP_MS,
      onlineExchanges: new Map(),
      onlineVersions: new Map(),
      onlineMutationInFlight: false,
      onlineDeletes: new Map(),
    };
    entry.timer = setInterval(() => {
      if (entry.renewal || entry.lost) return;
      void this.renew(entry).catch(() => {
        entry.lost = true;
      });
    }, HEARTBEAT_MS);
    entry.timer.unref?.();
    return entry;
  }

  private entry(shop: string) {
    const operation = this.operations.getStore();
    if (!operation || operation.closed)
      throw new WeleticGatewayError(
        "Shopify session operation context is required",
        409,
      );
    let pending = operation.pending.get(shop);
    if (!pending) {
      pending = this.acquire(shop);
      operation.pending.set(shop, pending);
    }
    return pending;
  }

  private async loadOnlineSession(id: string): Promise<Session | undefined> {
    const match = /^([a-z0-9][a-z0-9-]*\.myshopify\.com)_([1-9][0-9]*)$/.exec(
      id,
    );
    const operation = this.operations.getStore();
    if (!match || !operation || operation.closed) return undefined;
    const shop = match[1];
    const entry = await this.entry(shop);
    if (entry.onlineMutationInFlight)
      throw new WeleticGatewayError("Online session mutation in progress", 409);
    const originalVersion = entry.onlineVersions.get(id);
    await this.renew(entry, true);
    this.assertOwned(entry);
    const stored = await this.loadStoredSession(id);
    if (
      !stored?.onlineBinding ||
      typeof stored.onlineDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(stored.onlineDigest)
    )
      return undefined;
    let session: Session | undefined;
    try {
      const binding = shopifyOnlineSessionBindingSchema.parse(
        stored.onlineBinding,
      );
      if (
        binding.appId !== requireEnv("SHOPIFY_API_KEY") ||
        binding.shop !== shop ||
        binding.installationGeneration !==
          entry.snapshot.observed.installationGeneration ||
        !entry.snapshot.observed.credentialTokenHash
      )
        return undefined;
      bindShopifyOnlineSession(stored.properties, binding);
      session = deserializeShopifySession(stored.properties);
      if (
        !session ||
        session.id !== id ||
        !session.expires ||
        session.expires.getTime() <= Date.now()
      )
        return undefined;
    } catch {
      // Bad or legacy persistence evidence is a cache miss, not current authority.
      return undefined;
    }
    await this.renew(entry, true);
    this.assertOwned(entry);
    const evidence = readOnlineSessionEvidence(stored.properties);
    if (!evidence || !session.accessToken) return undefined;
    if (
      entry.onlineMutationInFlight ||
      originalVersion !== entry.onlineVersions.get(id)
    )
      return undefined;
    // Keep the first loaded version. Saving or reloading a replacement in this
    // operation must not retarget a delayed SDK deletion to the newer row.
    if (!entry.onlineDeletes.has(id))
      entry.onlineDeletes.set(id, {
        digest: stored.onlineDigest,
        observed: copyObservation(entry.snapshot.observed),
      });
    this.onlineObservations.set(session, {
      observed: copyObservation(entry.snapshot.observed),
      evidence,
      tokenDigest: createHash("sha256")
        .update(session.accessToken)
        .digest("hex"),
      expiresAt: session.expires!.getTime(),
      operation,
      version: entry.onlineVersions.get(id),
    });
    return session;
  }

  private async storeOnlineSession(session: Session) {
    const operation = this.operations.getStore();
    const pending =
      operation && !operation.closed
        ? operation.pending.get(session.shop)
        : undefined;
    if (!pending || !session.accessToken)
      throw new WeleticGatewayError(
        "Original online session exchange is required",
        409,
      );
    const entry = await pending;
    const digest = createHash("sha256")
      .update(session.accessToken)
      .digest("hex");
    const cached = this.onlineObservations.get(session);
    const origin =
      cached?.tokenDigest === digest && cached.operation === operation
        ? cached
        : entry.onlineExchanges.get(digest);
    if (
      !origin ||
      origin.version !== entry.onlineVersions.get(session.id) ||
      !session.expires ||
      !Number.isFinite(session.expires.getTime()) ||
      origin.expiresAt <= Date.now() ||
      session.expires.getTime() <= Date.now()
    )
      throw new WeleticGatewayError(
        "Original online session expiry is required",
        409,
      );
    if (cached === origin && session.expires.getTime() > origin.expiresAt)
      throw new WeleticGatewayError(
        "Cached online session expiry changed",
        409,
      );
    // SDK expiry is calculated after response processing. Clamp fresh exchanges
    // to the more conservative pre-request provider lifetime bound.
    session.expires = new Date(
      Math.min(session.expires.getTime(), origin.expiresAt),
    );
    const properties = serializeShopifySession(session);
    const evidence = readOnlineSessionEvidence(properties);
    if (
      !origin ||
      !sameObservation(origin.observed, entry.snapshot.observed) ||
      !evidence ||
      JSON.stringify(evidence) !== JSON.stringify(origin.evidence)
    )
      throw new WeleticGatewayError("Online session origin changed", 409);
    if (entry.onlineMutationInFlight)
      throw new WeleticGatewayError("Online session mutation in progress", 409);
    const version = Symbol("online publication");
    entry.onlineVersions.set(session.id, version);
    entry.onlineMutationInFlight = true;
    try {
      await this.renew(entry, true);
      this.assertOwned(entry);
      const result = await weleticApiJson<{ stored: true }>(
        "/api/internal/shopify/sessions",
        {
          method: "POST",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          body: JSON.stringify({
            properties,
            onlineCoordination: {
              lease: { ...entry.lease },
              observed: copyObservation(origin.observed),
            },
          }),
        },
      );
      if (result.stored !== true)
        throw new Error("Missing online publication acknowledgement");
      await this.renew(entry, true);
      this.assertOwned(entry);
      this.onlineObservations.set(session, {
        ...origin,
        tokenDigest: digest,
        expiresAt: session.expires.getTime(),
        operation: operation!,
        version,
      });
      return true;
    } catch {
      entry.lost = true;
      throw new WeleticGatewayError(
        "Online session publication unavailable",
        503,
      );
    } finally {
      entry.onlineMutationInFlight = false;
    }
  }

  /** One fresh provider exchange can mint one signed-gateway actor. Cached
   * sessions deliberately lack this evidence, even when their owner flag and
   * token expiry look valid. The caller must sign the complete returned actor
   * together with its operation; this method does not authorize a permission.
   */
  async mintMerchantActor(session: Session) {
    const operation = this.operations.getStore();
    const origin = this.onlineObservations.get(session);
    if (
      !operation ||
      operation.closed ||
      !origin ||
      origin.operation !== operation ||
      !origin.authenticatedAt ||
      !session.isOnline ||
      !session.accessToken
    )
      throw new WeleticGatewayError(
        "Fresh Shopify authentication is required",
        401,
      );
    const pending = operation.pending.get(session.shop);
    if (!pending)
      throw new WeleticGatewayError(
        "Original Shopify operation is required",
        409,
      );
    const entry = await pending;
    const tokenDigest = createHash("sha256")
      .update(session.accessToken)
      .digest("hex");
    const exchange = entry.onlineExchanges.get(tokenDigest);
    if (
      !exchange ||
      exchange.actorIssued ||
      exchange.authenticatedAt !== origin.authenticatedAt ||
      origin.tokenDigest !== tokenDigest ||
      origin.version !== entry.onlineVersions.get(session.id) ||
      entry.onlineMutationInFlight ||
      !sameObservation(origin.observed, entry.snapshot.observed)
    )
      throw new WeleticGatewayError(
        "Fresh Shopify authentication is required",
        401,
      );
    // Reserve before asynchronous reads, so parallel callers cannot mint twice.
    exchange.actorIssued = true;
    await this.renew(entry, true);
    this.assertOwned(entry);
    const stored = await this.loadStoredSession(session.id);
    if (
      !stored ||
      JSON.stringify(stored.properties) !==
        JSON.stringify(serializeShopifySession(session))
    )
      throw new WeleticGatewayError("Online Shopify session changed", 409);
    const binding = shopifyOnlineSessionBindingSchema.parse(
      stored.onlineBinding,
    );
    if (
      binding.appId !== requireEnv("SHOPIFY_API_KEY") ||
      binding.shop !== session.shop ||
      binding.installationGeneration !== origin.observed.installationGeneration
    )
      throw new WeleticGatewayError("Shopify installation changed", 409);
    bindShopifyOnlineSession(stored.properties, binding);
    const actor = shopifyMerchantActorEnvelopeSchema.parse({
      ...binding,
      version: 1,
      userId: String(exchange.evidence.userId),
      sessionId: session.id,
      sessionDigest: stored.onlineDigest,
      authenticatedAt: exchange.authenticatedAt,
      requestId: randomBytes(32).toString("hex"),
    });
    await this.renew(entry, true);
    this.assertOwned(entry);
    if (
      entry.onlineMutationInFlight ||
      origin.version !== entry.onlineVersions.get(session.id) ||
      !session.expires ||
      session.expires.getTime() <= Date.now() ||
      !isFreshShopifyMerchantActor(actor, Date.now())
    )
      throw new WeleticGatewayError(
        "Fresh Shopify authentication is required",
        401,
      );
    return actor;
  }

  override async loadSession(id: string) {
    const shop = offlineShop(id);
    if (!shop) return this.loadOnlineSession(id);
    const operation = this.operations.getStore();
    const snapshot =
      operation && !operation.closed
        ? (await this.entry(shop)).snapshot
        : await this.snapshot(shop);
    if (!snapshot.properties) return undefined;
    const session = Session.fromPropertyArray(snapshot.properties, true);
    this.observations.set(session, copyObservation(snapshot.observed));
    return session;
  }

  override async storeSession(session: Session) {
    if (session.isOnline) return this.storeOnlineSession(session);
    const shop = offlineShop(session.id);
    if (!shop || shop !== session.shop)
      throw new WeleticGatewayError("Invalid offline session scope", 400);
    const original = this.observations.get(session);
    const operation = this.operations.getStore();
    if (!operation || operation.closed) {
      // A late SDK 401 mutates a previously loaded object after authenticate()
      // returns. Reacquire ownership, but retain THAT object's observation.
      if (!original)
        throw new WeleticGatewayError(
          "Original Shopify session observation is missing",
          409,
        );
      return this.runOperation(() =>
        this.storeObserved(session, shop, original),
      );
    }
    const pending = operation.pending.get(shop);
    if (!pending)
      throw new WeleticGatewayError(
        "Original Shopify session observation is missing",
        409,
      );
    const entry = await pending;
    return this.storeObserved(
      session,
      shop,
      original ?? entry.snapshot.observed,
    );
  }

  private async storeObserved(
    session: Session,
    shop: string,
    original: ShopifySessionObservation,
  ) {
    const entry = await this.entry(shop);
    this.assertOwned(entry);
    if (!sameObservation(original, entry.snapshot.observed))
      throw new WeleticGatewayError("Original Shopify session is stale", 409);
    let properties = session.toPropertyArray(true);
    if (session.accessToken) {
      try {
        const scopes = await fetchCurrentAppInstallationScopes({
          shop,
          accessToken: session.accessToken,
        });
        properties = properties.filter(([key]) => key !== "scope");
        properties.push(["scope", scopes.join(",")]);
      } catch {
        // Preserve refreshed credentials even if optional scope reconciliation
        // is temporarily unavailable. Existing financial scope gates remain.
      }
    }
    this.assertOwned(entry);
    const coordination: ShopifySessionMutationFence = {
      lease: { ...entry.lease },
      observed: copyObservation(original),
    };
    const result = await weleticApiJson<{
      stored: true;
      coordination: ShopifySessionMutationFence;
    }>(MUTATION_PATH, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        properties,
        expectedCredentialTokenHash: original.credentialTokenHash,
        coordination,
      }),
    }).catch(() => {
      entry.lost = true;
      throw new WeleticGatewayError("Session publication unavailable", 503);
    });
    if (
      result?.stored !== true ||
      !this.validMutationAcknowledgement(entry, result.coordination)
    ) {
      entry.lost = true;
      throw new WeleticGatewayError(
        "Coordinated session publication was not acknowledged",
        503,
      );
    }
    entry.lease = { ...result.coordination.lease };
    entry.snapshot = {
      properties,
      observed: copyObservation(result.coordination.observed),
    };
    this.observations.set(
      session,
      copyObservation(result.coordination.observed),
    );
    return true;
  }

  private validMutationAcknowledgement(
    entry: Entry,
    fence?: ShopifySessionMutationFence,
  ) {
    try {
      return Boolean(
        fence?.lease?.token === entry.lease.token &&
          fence?.lease?.epoch === entry.lease.epoch &&
          fence?.lease?.revision === nextCounter(entry.lease.revision) &&
          fence?.observed?.revision === fence?.lease?.revision &&
          fence?.observed?.epoch === fence?.lease?.epoch &&
          /^[a-f0-9]{64}$/.test(fence?.observed?.sessionDigest),
      );
    } catch {
      return false;
    }
  }

  override async deleteSessions(ids: string[]) {
    const operation = this.operations.getStore();
    if (!operation || operation.closed)
      throw new WeleticGatewayError(
        "Original Shopify session observation is missing",
        409,
      );
    for (const id of ids) {
      const shop = offlineShop(id);
      if (!shop) {
        const match = /^([a-z0-9][a-z0-9-]*\.myshopify\.com)_[1-9][0-9]*$/.exec(
          id,
        );
        const pending = match ? operation.pending.get(match[1]) : undefined;
        if (!pending)
          throw new WeleticGatewayError(
            "Original online deletion scope is missing",
            409,
          );
        const entry = await pending;
        const original = entry.onlineDeletes.get(id);
        if (
          !original ||
          !sameObservation(original.observed, entry.snapshot.observed)
        )
          throw new WeleticGatewayError(
            "Original online deletion version is missing",
            409,
          );
        if (entry.onlineMutationInFlight)
          throw new WeleticGatewayError(
            "Online session mutation in progress",
            409,
          );
        entry.onlineMutationInFlight = true;
        entry.onlineVersions.set(id, Symbol("online deletion"));
        try {
          await this.renew(entry, true);
          this.assertOwned(entry);
          const result = await weleticApiJson<{ deleted: number }>(
            "/api/internal/shopify/sessions",
            {
              method: "DELETE",
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
              body: JSON.stringify({
                ids: [id],
                onlineDeletion: {
                  shop: entry.shop,
                  expectedPayloadDigest: original.digest,
                  coordination: {
                    lease: { ...entry.lease },
                    observed: copyObservation(original.observed),
                  },
                },
              }),
            },
          );
          if (result.deleted !== 0 && result.deleted !== 1)
            throw new Error("Missing online deletion acknowledgement");
          await this.renew(entry, true);
          this.assertOwned(entry);
        } catch {
          entry.lost = true;
          throw new WeleticGatewayError(
            "Online session deletion unavailable",
            503,
          );
        } finally {
          entry.onlineMutationInFlight = false;
        }
        continue;
      }
      const pending = operation.pending.get(shop);
      if (!pending)
        throw new WeleticGatewayError(
          "Original Shopify session observation is missing",
          409,
        );
      const entry = await pending;
      this.assertOwned(entry);
      const result = await weleticApiJson<{
        deleted: number;
        coordination: ShopifySessionMutationFence;
      }>(MUTATION_PATH, {
        method: "DELETE",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        body: JSON.stringify({
          ids: [id],
          coordination: {
            lease: entry.lease,
            observed: entry.snapshot.observed,
          },
        }),
      }).catch(() => {
        entry.lost = true;
        throw new WeleticGatewayError("Session deletion unavailable", 503);
      });
      if (!this.validMutationAcknowledgement(entry, result?.coordination)) {
        entry.lost = true;
        throw new WeleticGatewayError(
          "Coordinated session deletion was not acknowledged",
          503,
        );
      }
      entry.lease = { ...result.coordination.lease };
      entry.snapshot = {
        properties: null,
        observed: copyObservation(result.coordination.observed),
      };
    }
    return true;
  }

  override async findSessionsByShop(shop: string) {
    const sessions = await super.findSessionsByShop(shop);
    const observed = await Promise.all(
      sessions.map((session) => this.loadSession(session.id)),
    );
    return observed.filter((session): session is Session => Boolean(session));
  }
}
