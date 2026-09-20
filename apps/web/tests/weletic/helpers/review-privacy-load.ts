import { prisma } from "@/lib/prisma";
import { buildReviewPrivacyOwnerProjection } from "@/lib/weletic/reviews/privacy-owner-contract";
import { buildReviewPublicPrivacySql } from "@/lib/weletic/reviews/privacy-public-sql";
import { getPublicProductReviews } from "@/lib/weletic/reviews/public";
import { upsertShopifyCustomerPrivacyTombstones } from "@/lib/weletic/shopify/privacy-identity";
import { Prisma } from "@prisma/client";
import { performance } from "node:perf_hooks";
import { expect } from "vitest";

// Never emit complete EXPLAIN JSON: attached conditions contain private proofs.
function planAccess(value: unknown): Array<{
  table: string;
  access: string;
  key: string | null;
  rows: number | null;
}> {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(planAccess);
  const object = value as Record<string, unknown>;
  const current =
    typeof object.table_name === "string"
      ? [
          {
            table: object.table_name,
            access: String(object.access_type ?? "unknown"),
            key: typeof object.key === "string" ? object.key : null,
            rows:
              typeof object.rows_examined_per_scan === "number"
                ? object.rows_examined_per_scan
                : null,
          },
        ]
      : [];
  return [...current, ...Object.values(object).flatMap(planAccess)];
}

/** Disposable fixture only. Bulk rows are synthetic/unverified; no request,
 * delivery, order webhook or incentive lifecycle is claimed by this load probe.
 */
export async function verifyReviewPrivacyLoad(input: { run: string }) {
  if (
    process.env.LOYALTY_DATABASE_INTEGRATION !== "1" ||
    !process.env.DATABASE_URL ||
    !new URL(process.env.DATABASE_URL).pathname.startsWith(
      "/weletic_loyalty_it_",
    )
  )
    throw new Error("Review load probe requires isolated SQL");
  const stores = [`load-a-${input.run}`, `load-b-${input.run}`];
  const storeId = stores[0];
  const productId = `product-${storeId}`;
  const externalId = "gid://shopify/Product/888777";
  const now = new Date("2026-09-20T00:00:00.000Z");
  const rows = Array.from({ length: 1000 }, (_, index) => ({
    id: `review-${storeId}-${String(index).padStart(5, "0")}`,
    index,
    rating: (index % 5) + 1,
    createdAt: new Date(now.getTime() + Math.floor(index / 3)),
  }));
  const measurements: Array<{
    query: string;
    milliseconds: number;
    accesses?: ReturnType<typeof planAccess>;
  }> = [];
  const measure = async <T>(query: string, operation: () => Promise<T>) => {
    const start = performance.now();
    const result = await operation();
    measurements.push({
      query,
      milliseconds: Math.round((performance.now() - start) * 100) / 100,
    });
    return result;
  };
  try {
    for (const [tenant, scopedStore] of stores.entries()) {
      const owners = tenant === 0 ? 100 : 200;
      const scopedProduct = `product-${scopedStore}`;
      const scopedWorkspace = `workspace-${scopedStore}`;
      const scopedProgram = `program-${scopedStore}`;
      await prisma.project.create({
        data: {
          id: scopedWorkspace,
          name: "Synthetic review load",
          slug: scopedWorkspace,
          billingCycleStart: 1,
        },
      });
      await prisma.program.create({
        data: {
          id: scopedProgram,
          workspaceId: scopedWorkspace,
          defaultFolderId: `folder-${scopedStore}`,
          defaultGroupId: `group-${scopedStore}`,
          name: "Synthetic review load",
          slug: scopedProgram,
        },
      });
      await prisma.weleticShopifyStore.create({
        data: {
          id: scopedStore,
          projectId: scopedWorkspace,
          programId: scopedProgram,
          shopDomain: `${scopedStore}.myshopify.com`,
          shopCurrency: "USD",
          apiVersion: "2026-07",
          installationGeneration: "g1",
          storeAccessState: "active",
        },
      });
      await prisma.weleticReviewSettings.create({
        data: {
          storeId: scopedStore,
          enabled: true,
          requestEmailEnabled: false,
        },
      });
      await prisma.weleticShopifyProduct.create({
        data: {
          id: scopedProduct,
          storeId: scopedStore,
          programId: scopedProgram,
          externalId,
          handle: "synthetic-load",
          title: "Synthetic load fixture",
        },
      });
      for (let offset = 0; offset < owners; offset += 50) {
        const shoppers = Array.from(
          { length: Math.min(50, owners - offset) },
          (_, n) => ({
            id: `owner-${scopedStore}-${offset + n}`,
            storeId: scopedStore,
            shopifyCustomerId: String(900000 + offset + n),
            email: `load-${offset + n}@example.test`,
          }),
        );
        await prisma.weleticShopper.createMany({ data: shoppers });
        const projections = shoppers.map((shopper) =>
          buildReviewPrivacyOwnerProjection({
            ...shopper,
            shopperId: shopper.id,
            installationGeneration: "g1",
          }),
        );
        await prisma.weleticReviewOwnerPrivacyCoverage.createMany({
          data: projections.map((p) => ({
            storeId: scopedStore,
            shopperId: p.shopperId,
            installationGeneration: "g1",
            state: "active",
            keySetDigest: p.keySetDigest,
            sourceDigest: p.sourceDigest,
            identityCount: p.identities.length,
          })),
        });
        await prisma.weleticReviewOwnerPrivacyIdentity.createMany({
          data: projections.flatMap((p) =>
            p.identities.map((identity) => ({
              storeId: scopedStore,
              shopperId: p.shopperId,
              ...identity,
            })),
          ),
        });
      }
      for (let offset = 0; offset < owners * 10; offset += 250) {
        const batch = Array.from(
          { length: Math.min(250, owners * 10 - offset) },
          (_, n) => {
            const index = offset + n;
            return {
              index,
              suffix: `${scopedStore}-${String(index).padStart(5, "0")}`,
              shopperId: `owner-${scopedStore}-${Math.floor(index / 10)}`,
              createdAt: new Date(now.getTime() + Math.floor(index / 3)),
            };
          },
        );
        await prisma.weleticCommerceOrder.createMany({
          data: batch.map((row) => ({
            id: `order-${row.suffix}`,
            storeId: scopedStore,
            programId: scopedProgram,
            shopperId: row.shopperId,
            externalId: String(100000 + row.index),
            occurredAt: row.createdAt,
            presentmentCurrency: "USD",
            presentmentSubtotal: 100,
            presentmentNet: 100,
            presentmentTotal: 100,
            shopCurrency: "USD",
            shopSubtotal: 100,
            shopNet: 100,
            shopTotal: 100,
            accountingCurrency: "USD",
            accountingNet: 100,
            accountingTotal: 100,
            accountingFxRate: new Prisma.Decimal(1),
          })),
        });
        await prisma.weleticReviewRequest.createMany({
          data: batch.map((row) => ({
            id: `request-${row.suffix}`,
            storeId: scopedStore,
            orderId: `order-${row.suffix}`,
            productId: scopedProduct,
            shopperId: row.shopperId,
            installationGeneration: "g1",
            status: "submitted",
            fulfilledAt: now,
            sendAt: now,
            expiresAt: now,
          })),
        });
        await prisma.weleticProductReview.createMany({
          data: batch.map((row) => ({
            id: `review-${row.suffix}`,
            storeId: scopedStore,
            requestId: `request-${row.suffix}`,
            productId: scopedProduct,
            shopperId: row.shopperId,
            rating: (row.index % 5) + 1,
            title: "Synthetic unverified review",
            body: "Synthetic benchmark content; not an actual purchase or review.",
            displayName: "Fixture",
            verifiedPurchase: false,
            rewardStatus: "ineligible",
            status: "published",
            createdAt: row.createdAt,
          })),
        });
      }
    }
    // Same emails/customer IDs exist in the foreign tenant; only target-store
    // owners are suppressed. Tombstones are intentionally expired but retained.
    for (let owner = 0; owner < 100; owner += 5)
      await upsertShopifyCustomerPrivacyTombstones({
        storeId,
        email: `load-${owner}@example.test`,
        expiresAt: new Date("2000-01-01"),
      });
    const expected = rows.filter((row) => Math.floor(row.index / 10) % 5 !== 0);
    expect(expected).toHaveLength(800);
    const privacy = buildReviewPublicPrivacySql({
      storeId,
      productId,
      installationGeneration: "g1",
    });
    const queries = {
      unknown: Prisma.sql`SELECT r.id FROM ${privacy.from} WHERE ${privacy.unknown} LIMIT 1`,
      aggregate: Prisma.sql`SELECT r.rating, COUNT(*) AS count FROM ${privacy.from} WHERE ${privacy.eligible} GROUP BY r.rating`,
      newest: Prisma.sql`SELECT r.id FROM ${privacy.from} WHERE ${privacy.eligible} ORDER BY r.createdAt DESC, r.id DESC LIMIT 51`,
      highest: Prisma.sql`SELECT r.id FROM ${privacy.from} WHERE ${privacy.eligible} ORDER BY r.rating DESC, r.createdAt DESC, r.id DESC LIMIT 51`,
      filtered: Prisma.sql`SELECT r.id FROM ${privacy.from} WHERE ${privacy.eligible} AND r.rating = 1 ORDER BY r.createdAt DESC, r.id DESC LIMIT 51`,
    };
    for (const [name, query] of Object.entries(queries)) {
      const plans = await prisma.$queryRaw<Array<Record<string, unknown>>>(
        Prisma.sql`EXPLAIN FORMAT=JSON ${query}`,
      );
      expect(plans).toHaveLength(1);
      const value = Object.values(plans[0])[0];
      const accesses = planAccess(
        typeof value === "string" ? JSON.parse(value) : value,
      );
      expect(accesses.length).toBeGreaterThan(0);
      expect(accesses.some((a) => a.table === "r" && a.key !== null)).toBe(
        true,
      );
      measurements.push({ query: `plan_${name}`, milliseconds: 0, accesses });
    }
    const unknown = await measure("unknown", () =>
      prisma.$queryRaw<Array<{ id: string }>>(queries.unknown),
    );
    expect(unknown).toEqual([]);
    const aggregate = await measure("aggregate", () =>
      prisma.$queryRaw<Array<{ rating: number; count: bigint }>>(
        queries.aggregate,
      ),
    );
    expect(
      aggregate.map((row) => [row.rating, Number(row.count)]).sort(),
    ).toEqual([
      [1, 160],
      [2, 160],
      [3, 160],
      [4, 160],
      [5, 160],
    ]);
    for (const sort of ["newest", "highest", "lowest"] as const) {
      const ordered = [...expected].sort(
        (a, b) =>
          (sort === "newest"
            ? 0
            : sort === "highest"
              ? b.rating - a.rating
              : a.rating - b.rating) ||
          b.createdAt.getTime() - a.createdAt.getTime() ||
          b.id.localeCompare(a.id),
      );
      const first = await measure(`public_${sort}`, () =>
        getPublicProductReviews(storeId, {
          productId: externalId,
          sort,
          limit: 50,
        }),
      );
      expect(first.summary).toEqual({
        count: 800,
        average: 3,
        distribution: { 1: 160, 2: 160, 3: 160, 4: 160, 5: 160 },
      });
      expect(first.items.map((row) => row.id)).toEqual(
        ordered.slice(0, 50).map((row) => row.id),
      );
      expect(first.nextCursor).toBeTruthy();
      const second = await measure(`public_${sort}_cursor`, () =>
        getPublicProductReviews(storeId, {
          productId: externalId,
          sort,
          limit: 50,
          cursor: first.nextCursor,
        }),
      );
      expect(second.items.map((row) => row.id)).toEqual(
        ordered.slice(50, 100).map((row) => row.id),
      );
      expect(JSON.stringify(first.items)).not.toContain("@example.test");
    }
    const foreign = await getPublicProductReviews(stores[1], {
      productId: externalId,
      limit: 1,
    });
    expect(foreign.summary.count).toBe(2000);
    console.log(
      JSON.stringify({
        event: "isolated_review_privacy_load",
        targetReviews: 1000,
        foreignReviews: 2000,
        targetOwners: 100,
        foreignOwners: 200,
        retainedSuppressedReviews: 200,
        measurements,
      }),
    );
  } finally {
    const where = { storeId: { in: stores } };
    await prisma.weleticProductReview.deleteMany({ where });
    await prisma.weleticReviewRequest.deleteMany({ where });
    await prisma.weleticCommerceOrder.deleteMany({ where });
    await prisma.weleticShopifyCustomerPrivacyTombstone.deleteMany({ where });
    await prisma.weleticReviewOwnerPrivacyIdentity.deleteMany({ where });
    await prisma.weleticReviewOwnerPrivacyCoverage.deleteMany({ where });
    await prisma.weleticShopper.deleteMany({ where });
    await prisma.weleticReviewSettings.deleteMany({ where });
    await prisma.weleticShopifyProduct.deleteMany({ where });
    await prisma.weleticShopifyStore.deleteMany({
      where: { id: { in: stores } },
    });
    // Exact fixture parents have no remaining children. Avoid Prisma's
    // emulated cascade into unrelated legacy enrollment relations.
    await prisma.$executeRaw(Prisma.sql`
      DELETE FROM Program WHERE id IN (${Prisma.join(stores.map((id) => `program-${id}`))})
    `);
    await prisma.$executeRaw(Prisma.sql`
      DELETE FROM Project WHERE id IN (${Prisma.join(stores.map((id) => `workspace-${id}`))})
    `);
    expect(
      await prisma.program.count({
        where: { id: { in: stores.map((id) => `program-${id}`) } },
      }),
    ).toBe(0);
    expect(
      await prisma.project.count({
        where: { id: { in: stores.map((id) => `workspace-${id}`) } },
      }),
    ).toBe(0);
    expect(await prisma.weleticProductReview.count({ where })).toBe(0);
  }
}
