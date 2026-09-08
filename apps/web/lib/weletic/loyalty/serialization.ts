import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

/**
 * Recursively serializes loyalty data:
 * - Converts BigInt -> decimal string
 * - Converts Prisma.Decimal / Decimal.js -> string
 * - Converts Date -> ISO string
 * - Recursively processes Arrays and Objects
 * - Preserves numbers, booleans, and strings
 */
export function serializeLoyaltyData<T>(obj: T): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === "bigint") {
    return obj.toString();
  }

  if (
    typeof obj === "object" &&
    obj !== null &&
    (("d" in obj && "e" in obj && "s" in obj) ||
      (typeof (obj as any).toFixed === "function" &&
        (obj as any).isDecimal?.()) ||
      obj instanceof Prisma.Decimal)
  ) {
    return obj.toString();
  }

  if (obj instanceof Date) {
    return obj.toISOString();
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => serializeLoyaltyData(item));
  }

  if (typeof obj === "object") {
    const res: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      res[key] = serializeLoyaltyData(value);
    }
    return res;
  }

  return obj;
}

/**
 * Standard HTTP JSON Success Response Envelope: { "data": ... }
 */
export function loyaltySuccessResponse<T>(
  data: T,
  init?: ResponseInit | { status?: number; headers?: HeadersInit },
) {
  const serialized = serializeLoyaltyData(data);
  return NextResponse.json({ data: serialized }, init);
}

/**
 * Standard HTTP JSON Error Response Envelope: { "error": { "code": "...", "message": "..." } }
 */
export function loyaltyErrorResponse(
  code: string,
  message: string,
  status: number = 400,
  details?: any,
  init?: ResponseInit | { headers?: HeadersInit },
) {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        ...(details !== undefined
          ? { details: serializeLoyaltyData(details) }
          : {}),
      },
    },
    {
      status,
      ...init,
    },
  );
}
