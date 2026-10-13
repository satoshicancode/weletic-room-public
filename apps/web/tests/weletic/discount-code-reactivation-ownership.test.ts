import { DubApiError } from "@/lib/api/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Row = {
  id: string;
  code: string;
  programId: string;
  partnerId: string;
  linkId: string | null;
  discountId: string;
  disabledAt: Date | null;
};

const rows = new Map<string, Row>();
const providerCreate = vi.hoisted(() => vi.fn());
const providerDisable = vi.hoisted(() => vi.fn());

function matches(row: Row, where: any = {}) {
  if (where.id?.not && row.id === where.id.not) return false;
  if (typeof where.id === "string" && row.id !== where.id) return false;
  if (where.programId && row.programId !== where.programId) return false;
  if (typeof where.code === "string" && row.code !== where.code) return false;
  if (where.code?.in && !where.code.in.includes(row.code)) return false;
  if (where.linkId && row.linkId !== where.linkId) return false;
  if (where.disabledAt === null && row.disabledAt !== null) return false;
  if (where.disabledAt?.not === null && row.disabledAt === null) return false;
  return true;
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    discountCode: {
      findFirst: vi.fn(async ({ where }: any) => {
        for (const r of rows.values()) if (matches(r, where)) return r;
        return null;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const [id, r] of rows) {
          if (matches(r, where)) {
            rows.set(id, { ...r, ...data });
            count++;
          }
        }
        return { count };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const next = { ...rows.get(where.id)!, ...data };
        rows.set(where.id, next);
        return next;
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = { disabledAt: null, ...data } as Row;
        rows.set(row.id, row);
        return row;
      }),
    },
  },
}));

vi.mock("@/lib/discounts/discount-provider", () => ({
  getDiscountProvider: () => ({
    createDiscountCode: providerCreate,
    disableDiscountCode: providerDisable,
  }),
}));

import {
  createDiscountCode,
  DISCOUNT_CODE_OWNED_BY_OTHER_PARTNER_MESSAGE,
} from "@/lib/discounts/create-discount-code";

const workspace = {
  id: "ws_1",
  stripeConnectId: null,
  shopifyStoreId: "store_1",
};
const discount = {
  id: "disc_1",
  programId: "prog_1",
  amount: 10,
  type: "percentage",
  provider: "shopify",
} as any;
const alice = { id: "partner_alice", name: "Alice Doe" };
const bob = { id: "partner_bob", name: "Bob Roe" };
const link = { id: "link_bob_1" };

function seedDisabled(partnerId: string, code = "SUMMER10") {
  rows.set("dcode_1", {
    id: "dcode_1",
    code,
    programId: "prog_1",
    partnerId,
    linkId: null,
    discountId: "disc_1",
    disabledAt: new Date("2026-08-01T00:00:00Z"),
  });
}

describe("createDiscountCode: disabled code ownership", () => {
  beforeEach(() => {
    rows.clear();
    providerCreate.mockReset();
    providerDisable.mockReset();
    providerCreate.mockImplementation(async ({ code }: any) => ({ code }));
  });

  it("same partner can reactivate their own disabled code in place", async () => {
    seedDisabled(bob.id);

    const result = await createDiscountCode({
      workspace,
      partner: bob,
      link,
      discount,
      code: "SUMMER10",
    });

    expect(result.id).toBe("dcode_1");
    expect(result.partnerId).toBe(bob.id);
    expect(result.disabledAt).toBeNull();
    expect(result.linkId).toBe(link.id);
    expect(providerCreate).toHaveBeenCalledTimes(1);
  });

  it("rejects another partner's disabled code even when typed in a different case", async () => {
    seedDisabled(alice.id, "SUMMER10");

    const err = await createDiscountCode({
      workspace,
      partner: bob,
      link,
      discount,
      code: "summer10",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(DubApiError);
    expect(err.code).toBe("conflict");
    expect(err.message).toMatch(/choose a different code/i);
    expect(rows.get("dcode_1")?.partnerId).toBe(alice.id);
    expect(providerCreate).not.toHaveBeenCalled();
  });

  it("same partner reactivates in place when typing the code in a different case", async () => {
    seedDisabled(bob.id, "SUMMER10");

    const result = await createDiscountCode({
      workspace,
      partner: bob,
      link,
      discount,
      code: "summer10",
    });

    expect(result.id).toBe("dcode_1");
    expect(result.partnerId).toBe(bob.id);
    expect(result.disabledAt).toBeNull();
    expect(rows.size).toBe(1);
  });

  it("rejects an explicit code that belongs to another partner with a clear 409", async () => {
    seedDisabled(alice.id);

    const err = await createDiscountCode({
      workspace,
      partner: bob,
      link,
      discount,
      code: "SUMMER10",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(DubApiError);
    expect(err.code).toBe("conflict");
    expect(err.message).toBe(
      DISCOUNT_CODE_OWNED_BY_OTHER_PARTNER_MESSAGE("SUMMER10"),
    );
    expect(err.message).toMatch(/choose a different code/i);

    // Ownership and state are untouched, and nothing was pushed to the provider.
    expect(rows.get("dcode_1")).toMatchObject({
      partnerId: alice.id,
      disabledAt: expect.any(Date),
      linkId: null,
    });
    expect(providerCreate).not.toHaveBeenCalled();
  });

  it("auto-generated code colliding with another partner's disabled code gets a suffix", async () => {
    // constructDiscountCode(Bob, 10%) => BOB10OFF
    seedDisabled(alice.id, "BOB10OFF");

    const result = await createDiscountCode({
      workspace,
      partner: bob,
      link,
      discount,
    });

    expect(result.code).toBe("BOB10OFF2");
    expect(result.partnerId).toBe(bob.id);
    expect(result.id).not.toBe("dcode_1");
    expect(rows.get("dcode_1")).toMatchObject({
      partnerId: alice.id,
      code: "BOB10OFF",
    });
    expect(providerCreate).toHaveBeenCalledWith(
      expect.objectContaining({ code: "BOB10OFF2" }),
    );
  });

  it("creates a brand new code when nothing disabled exists", async () => {
    const result = await createDiscountCode({
      workspace,
      partner: bob,
      link,
      discount,
      code: "FRESH",
    });
    expect(result.code).toBe("FRESH");
    expect(result.partnerId).toBe(bob.id);
  });
});
