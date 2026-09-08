import { Prisma, PrismaClient } from "@prisma/client";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireShopifySessionLease as acquireObservedLease,
  advanceLegacyShopifySessionRevision,
  advanceShopifySessionRevision,
  observeShopifySessionCoordination,
  releaseShopifySessionLease,
  renewShopifySessionLease,
  shopifySessionCoordinationId,
  type ShopifySessionScope,
} from "../../lib/weletic/shopify/session-coordination";

const prisma = new PrismaClient();
const scopes: ShopifySessionScope[] = [];
const sessionIds: string[] = [];
let safeToClean = false;
const token = () => randomBytes(32).toString("hex");
const initialObservation = { epoch: "0", revision: "0" };
const acquireShopifySessionLease = (
  tx: Prisma.TransactionClient,
  target: ShopifySessionScope,
  owner: string,
  observed = initialObservation,
) => acquireObservedLease(tx, target, owner, observed);
const transaction = <T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) => prisma.$transaction(operation, { maxWait: 15_000, timeout: 15_000 });
const scope = (appId = "session-coordination-test") => {
  const value = { appId, shop: `lease-${randomUUID()}.myshopify.com` };
  scopes.push(value);
  return value;
};

describe("Shopify session coordination with real MySQL transactions", () => {
  beforeAll(async () => {
    if (process.env.SHOPIFY_SESSION_DATABASE_INTEGRATION !== "1") {
      throw new Error("Explicit Shopify session database test opt-in required");
    }
    const url = new URL(process.env.DATABASE_URL || "invalid:");
    if (
      url.protocol !== "mysql:" ||
      url.hostname !== "127.0.0.1" ||
      url.port !== "3307" ||
      url.username !== "loyalty_dev" ||
      url.pathname !== "/weletic_loyalty_dev"
    ) {
      throw new Error("Refusing a non-isolated Shopify session test database");
    }
    const identity = await prisma.$queryRaw<
      Array<{ databaseName: string; principal: string }>
    >`SELECT DATABASE() AS databaseName, CURRENT_USER() AS principal`;
    expect(identity).toEqual([
      { databaseName: "weletic_loyalty_dev", principal: "loyalty_dev@%" },
    ]);
    safeToClean = true;
  });

  afterAll(async () => {
    if (safeToClean) {
      // Only this run's generated IDs, never merchant rows or broad prefixes.
      await prisma.weleticShopifyAppSession.deleteMany({
        where: { id: { in: sessionIds } },
      });
      await prisma.weleticShopifySessionCoordination.deleteMany({
        where: { id: { in: scopes.map(shopifySessionCoordinationId) } },
      });
    }
    await prisma.$disconnect();
  });

  it("allows exactly one owner during concurrent first acquisition", async () => {
    const target = scope();
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, () =>
        transaction((tx) => acquireShopifySessionLease(tx, target, token())),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ code: "lease_busy" });
      }
    }
    const persisted =
      await prisma.weleticShopifySessionCoordination.findUniqueOrThrow({
        where: { id: shopifySessionCoordinationId(target) },
      });
    expect(persisted.revision).toBe(BigInt(0));
    expect(persisted.leaseEpoch).toBe(BigInt(1));
  });

  it("serializes legacy publication against first promotion and permanently rejects legacy writes afterward", async () => {
    const target = scope();
    const results = await Promise.allSettled([
      transaction((tx) => advanceLegacyShopifySessionRevision(tx, target)),
      transaction((tx) => acquireShopifySessionLease(tx, target, token())),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const observation = await transaction((tx) =>
      observeShopifySessionCoordination(tx, target),
    );
    if (observation.epoch === "0") {
      expect(observation.revision).toBe("1");
      const lease = await transaction((tx) =>
        acquireShopifySessionLease(tx, target, token(), observation),
      );
      await transaction((tx) => releaseShopifySessionLease(tx, lease));
    } else {
      expect(observation.revision).toBe("0");
    }
    await expect(
      transaction((tx) => advanceLegacyShopifySessionRevision(tx, target)),
    ).rejects.toMatchObject({ code: "stale_session" });
  });

  it("replays an active acquisition without extending its epoch or expiry", async () => {
    const target = scope();
    const owner = token();
    const first = await transaction((tx) =>
      acquireShopifySessionLease(tx, target, owner),
    );
    const before =
      await prisma.weleticShopifySessionCoordination.findUniqueOrThrow({
        where: { id: shopifySessionCoordinationId(target) },
      });
    const replay = await transaction((tx) =>
      acquireShopifySessionLease(tx, target, owner),
    );
    const after =
      await prisma.weleticShopifySessionCoordination.findUniqueOrThrow({
        where: { id: before.id },
      });
    expect(replay).toEqual(first);
    expect(after.leaseExpiresAt).toEqual(before.leaseExpiresAt);
    expect(after.leaseOwnerHash).not.toBe(owner);
  });

  it("fences released owners and replayed release/renewal across epochs", async () => {
    const target = scope();
    const first = await transaction((tx) =>
      acquireShopifySessionLease(tx, target, token()),
    );
    await expect(
      transaction((tx) => releaseShopifySessionLease(tx, first)),
    ).resolves.toBe(true);
    await expect(
      transaction((tx) => acquireShopifySessionLease(tx, target, first.token)),
    ).rejects.toMatchObject({ code: "lease_busy" });
    const next = await transaction((tx) =>
      acquireShopifySessionLease(tx, target, token(), first),
    );
    expect(BigInt(next.epoch)).toBe(BigInt(first.epoch) + BigInt(1));
    await expect(
      transaction((tx) => releaseShopifySessionLease(tx, first)),
    ).resolves.toBe(false);
    await expect(
      transaction((tx) => renewShopifySessionLease(tx, first)),
    ).rejects.toMatchObject({ code: "stale_session" });
    await expect(
      transaction((tx) => advanceShopifySessionRevision(tx, first)),
    ).rejects.toMatchObject({ code: "stale_session" });
    await expect(
      transaction((tx) => advanceShopifySessionRevision(tx, next)),
    ).resolves.toMatchObject({ revision: "1" });
  });

  it("does not revive expired ownership and lets a fresh owner recover", async () => {
    const target = scope();
    const first = await transaction((tx) =>
      acquireShopifySessionLease(tx, target, token()),
    );
    await prisma.$executeRaw`
      UPDATE WeleticShopifySessionCoordination
      SET leaseExpiresAt = TIMESTAMPADD(SECOND, -1, CURRENT_TIMESTAMP(3))
      WHERE id = ${shopifySessionCoordinationId(target)}
    `;
    await expect(
      transaction((tx) => renewShopifySessionLease(tx, first)),
    ).rejects.toMatchObject({ code: "stale_session" });
    await expect(
      transaction((tx) => advanceShopifySessionRevision(tx, first)),
    ).rejects.toMatchObject({ code: "stale_session" });
    const recovered = await transaction((tx) =>
      acquireShopifySessionLease(tx, target, token(), first),
    );
    expect(recovered.epoch).not.toBe(first.epoch);
    await transaction((tx) => renewShopifySessionLease(tx, recovered));
  });

  it("publishes one payload under competing writes of the same observation", async () => {
    const target = scope();
    const lease = await transaction((tx) =>
      acquireShopifySessionLease(tx, target, token()),
    );
    const id = `offline_${target.shop}`;
    sessionIds.push(id);
    const results = await Promise.allSettled(
      ["first-pair", "second-pair"].map((payload) =>
        transaction(async (tx) => {
          await advanceShopifySessionRevision(tx, lease);
          await tx.weleticShopifyAppSession.upsert({
            where: { id },
            create: { id, shop: target.shop, isOnline: false, payload },
            update: { payload },
          });
          return payload;
        }),
      ),
    );
    const winners = results.filter((result) => result.status === "fulfilled");
    expect(winners).toHaveLength(1);
    const winner = winners[0];
    if (winner.status !== "fulfilled")
      throw new Error("Expected one publication");
    expect(
      await prisma.weleticShopifyAppSession.findUnique({ where: { id } }),
    ).toMatchObject({ payload: winner.value });
    expect(
      await prisma.weleticShopifySessionCoordination.findUnique({
        where: { id: shopifySessionCoordinationId(target) },
      }),
    ).toMatchObject({ revision: BigInt(1) });
  });

  it("rolls back the revision and payload together on publication failure", async () => {
    const target = scope();
    const lease = await transaction((tx) =>
      acquireShopifySessionLease(tx, target, token()),
    );
    const id = `offline_${target.shop}`;
    sessionIds.push(id);
    await expect(
      transaction(async (tx) => {
        await advanceShopifySessionRevision(tx, lease);
        await tx.weleticShopifyAppSession.create({
          data: {
            id,
            shop: target.shop,
            isOnline: false,
            payload: "synthetic-pair",
          },
        });
        throw new Error("simulated publication failure");
      }),
    ).rejects.toThrow("simulated publication failure");
    expect(
      await prisma.weleticShopifyAppSession.findUnique({ where: { id } }),
    ).toBeNull();
    await expect(
      transaction((tx) => advanceShopifySessionRevision(tx, lease)),
    ).resolves.toMatchObject({ revision: "1" });
  });

  it("isolates coordinator ownership by app and shop", async () => {
    const a = scope();
    const b = { ...a, appId: "different-app" };
    scopes.push(b);
    const c = scope();
    const leases = await Promise.all(
      [a, b, c].map((value) =>
        transaction((tx) => acquireShopifySessionLease(tx, value, token())),
      ),
    );
    expect(new Set(leases.map(shopifySessionCoordinationId)).size).toBe(3);
    await expect(
      transaction((tx) =>
        advanceShopifySessionRevision(tx, { ...leases[0], appId: b.appId }),
      ),
    ).rejects.toMatchObject({ code: "stale_session" });
  });

  it("rejects an acquisition replay after an intervening owner (A/B/A)", async () => {
    const target = scope();
    const original = await transaction((tx) =>
      observeShopifySessionCoordination(tx, target),
    );
    expect(original).toEqual(initialObservation);
    const a = await transaction((tx) =>
      acquireShopifySessionLease(tx, target, token(), original),
    );
    await transaction((tx) => releaseShopifySessionLease(tx, a));
    const observedB = await transaction((tx) =>
      observeShopifySessionCoordination(tx, target),
    );
    const b = await transaction((tx) =>
      acquireShopifySessionLease(tx, target, token(), observedB),
    );
    await transaction((tx) => releaseShopifySessionLease(tx, b));
    await expect(
      transaction((tx) =>
        acquireShopifySessionLease(tx, target, a.token, original),
      ),
    ).rejects.toMatchObject({ code: "lease_busy" });
    const after = await transaction((tx) =>
      observeShopifySessionCoordination(tx, target),
    );
    expect(after.epoch).toBe(b.epoch);
  });

  it.each(["renew", "publish"] as const)(
    "rejects %s when a row-lock wait crosses expiry",
    async (action) => {
      const target = scope();
      const lease = await transaction((tx) =>
        acquireShopifySessionLease(tx, target, token()),
      );
      const id = shopifySessionCoordinationId(target);
      let locked!: () => void;
      let unlock!: () => void;
      const lockedPromise = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const unlockPromise = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const blocker = transaction(async (tx) => {
        await tx.$executeRaw`
        UPDATE WeleticShopifySessionCoordination
        SET leaseExpiresAt = TIMESTAMPADD(MICROSECOND, 300000, CURRENT_TIMESTAMP(3))
        WHERE id = ${id}
      `;
        locked();
        await unlockPromise;
      });
      await lockedPromise;
      const contender = transaction(async (tx) =>
        action === "renew"
          ? renewShopifySessionLease(tx, lease)
          : advanceShopifySessionRevision(tx, lease),
      );
      // Register the rejection assertion immediately so failures are never unhandled.
      const assertion = expect(contender).rejects.toMatchObject({
        code: "stale_session",
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 650));
      } finally {
        unlock();
      }
      await blocker;
      await assertion;
      const after = await transaction((tx) =>
        observeShopifySessionCoordination(tx, target),
      );
      expect(after.revision).toBe("0");
    },
  );
});
