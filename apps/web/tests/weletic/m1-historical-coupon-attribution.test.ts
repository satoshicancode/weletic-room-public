import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { findActiveDiscountCode } from "../../workers/queue-consumer/src/index";

describe("FIN-AUDIT-05 / WRK-AUDIT-06: Historical Coupon Attribution", () => {
  const programId = "prog_m1_test";
  const code = "SUMMER20";

  it("1. Attributes code when order was created BEFORE deactivation (orderCreatedAt <= disabledAt)", async () => {
    const disabledAt = new Date("2026-10-01T12:00:00Z");
    const orderCreatedAt = new Date("2026-10-01T10:00:00Z"); // 2 hours before deactivation

    const mockPrisma = {
      discountCode: {
        findFirst: vi.fn(async ({ where }) => {
          expect(where.programId).toBe(programId);
          expect(where.code).toBe(code);
          expect(where.OR).toEqual([
            { disabledAt: null },
            { disabledAt: { gte: orderCreatedAt } },
          ]);
          return {
            id: "dc_1",
            code,
            programId,
            partnerId: "partner_alice",
            linkId: "link_alice",
            disabledAt,
          };
        }),
      },
    };

    const result = await findActiveDiscountCode(
      mockPrisma as any,
      programId,
      code,
      orderCreatedAt,
    );

    expect(result).not.toBeNull();
    expect(result?.partnerId).toBe("partner_alice");
  });

  it("2. Rejects code when order was created AFTER deactivation (orderCreatedAt > disabledAt)", async () => {
    const disabledAt = new Date("2026-10-01T12:00:00Z");
    const orderCreatedAt = new Date("2026-10-01T14:00:00Z"); // 2 hours after deactivation

    const mockPrisma = {
      discountCode: {
        findFirst: vi.fn(async ({ where }) => {
          // When executing in a real DB or query filter, where.OR conditions
          // with disabledAt >= orderCreatedAt evaluates to false when orderCreatedAt > disabledAt
          const matches = where.OR.some((cond: any) => {
            if (cond.disabledAt === null) return false;
            if (cond.disabledAt?.gte) return disabledAt >= cond.disabledAt.gte;
            return false;
          });
          return matches ? { id: "dc_1", code, partnerId: "partner_alice" } : null;
        }),
      },
    };

    const result = await findActiveDiscountCode(
      mockPrisma as any,
      programId,
      code,
      orderCreatedAt,
    );

    expect(result).toBeNull();
  });

  it("3. Strictly enforces disabledAt: null when orderCreatedAt is omitted (Invariant 2 compatibility)", async () => {
    const mockPrisma = {
      discountCode: {
        findFirst: vi.fn(async ({ where }) => {
          expect(where.disabledAt).toBeNull();
          expect(where.OR).toBeUndefined();
          return null; // soft-deleted code not returned
        }),
      },
    };

    const result = await findActiveDiscountCode(
      mockPrisma as any,
      programId,
      code,
    );

    expect(result).toBeNull();
  });

  it("4. Fails closed when order timestamp is corrupted (FIN-AUDIT-11)", async () => {
    const mockPrisma = {
      discountCode: {
        findFirst: vi.fn(async ({ where }) => {
          expect(where.disabledAt).toBeNull();
          expect(where.OR).toBeUndefined();
          return null;
        }),
      },
    };

    const result = await findActiveDiscountCode(
      mockPrisma as any,
      programId,
      code,
      "invalid-date-string",
    );

    expect(result).toBeNull();
  });

  it("5. Attributes currently active code (disabledAt: null) regardless of order timestamp", async () => {
    const orderCreatedAt = new Date("2026-10-05T08:00:00Z");

    const mockPrisma = {
      discountCode: {
        findFirst: vi.fn(async () => ({
          id: "dc_active",
          code,
          programId,
          partnerId: "partner_bob",
          linkId: "link_bob",
          disabledAt: null,
        })),
      },
    };

    const result = await findActiveDiscountCode(
      mockPrisma as any,
      programId,
      code,
      orderCreatedAt,
    );

    expect(result).not.toBeNull();
    expect(result?.disabledAt).toBeNull();
  });
});
