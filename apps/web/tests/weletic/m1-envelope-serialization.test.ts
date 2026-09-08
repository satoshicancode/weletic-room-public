import {
  loyaltyErrorResponse,
  loyaltySuccessResponse,
  serializeLoyaltyData,
} from "@/lib/weletic/loyalty/serialization";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

describe("Milestone 1 (M1): Response Envelopes & BigInt Decimal String Serialization", () => {
  it("serializes arbitrary-precision BigInt integers and Decimals without precision loss", () => {
    const hugePoints = BigInt("9007199254740993"); // Number.MAX_SAFE_INTEGER + 2
    const maxUint64 = BigInt("18446744073709551615");
    const negativeDelta = BigInt("-25000000000");

    const payload = {
      pointsBalance: hugePoints,
      maxBalance: maxUint64,
      pointsDelta: negativeDelta,
      rate: new Prisma.Decimal("1.2500"),
      count: 42,
      enrolledAt: new Date("2026-08-26T00:00:00.000Z"),
    };

    const serialized = serializeLoyaltyData(payload);

    expect(serialized.pointsBalance).toBe("9007199254740993");
    expect(serialized.maxBalance).toBe("18446744073709551615");
    expect(serialized.pointsDelta).toBe("-25000000000");
    expect(serialized.rate).toBe("1.25");
    expect(serialized.count).toBe(42);
    expect(serialized.enrolledAt).toBe("2026-08-26T00:00:00.000Z");
  });

  it("enforces { data: ... } structure on success response", async () => {
    const res = loyaltySuccessResponse({
      accountId: "acc_1",
      pointsBalance: BigInt(5000),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      data: {
        accountId: "acc_1",
        pointsBalance: "5000",
      },
    });
  });

  it("enforces { error: { code, message } } structure on error response", async () => {
    const res = loyaltyErrorResponse(
      "insufficient_points",
      "Customer does not have enough points",
      422,
      { required: BigInt(500), available: BigInt(100) },
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json).toEqual({
      error: {
        code: "insufficient_points",
        message: "Customer does not have enough points",
        details: {
          required: "500",
          available: "100",
        },
      },
    });
  });
});
