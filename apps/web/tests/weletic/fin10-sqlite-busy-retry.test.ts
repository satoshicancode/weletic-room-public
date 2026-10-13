import {
  isRetriableSqliteError,
  withFinancialTransactionRetry,
} from "@/lib/weletic/sqlite-retry";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("FIN-AUDIT-10: SQLite / D1 Write Concurrency & Busy Retry Loop", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("isRetriableSqliteError classifier", () => {
    it("identifies Prisma P2034 transaction conflict as retriable", () => {
      const err = new Prisma.PrismaClientKnownRequestError(
        "Transaction failed",
        {
          code: "P2034",
          clientVersion: "6.19.1",
        },
      );
      expect(isRetriableSqliteError(err)).toBe(true);
    });

    it("identifies Prisma P2028 transaction closed / timeout as retriable", () => {
      const err = new Prisma.PrismaClientKnownRequestError(
        "Transaction closed",
        {
          code: "P2028",
          clientVersion: "6.19.1",
        },
      );
      expect(isRetriableSqliteError(err)).toBe(true);
    });

    it("identifies raw SQLite_BUSY error messages as retriable", () => {
      const err = new Error("SQLITE_BUSY: database is locked");
      expect(isRetriableSqliteError(err)).toBe(true);
    });

    it("identifies Cloudflare D1 stepping error as retriable", () => {
      const err = new Error("D1_ERROR: stepping, database is locked (5)");
      expect(isRetriableSqliteError(err)).toBe(true);
    });

    it("does NOT retry non-transient errors (P2002 unique constraint)", () => {
      const err = new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed",
        {
          code: "P2002",
          clientVersion: "6.19.1",
        },
      );
      expect(isRetriableSqliteError(err)).toBe(false);
    });

    it("does NOT retry PrismaClientValidationError", () => {
      const err = new Prisma.PrismaClientValidationError("Missing argument", {
        clientVersion: "6.19.1",
      });
      expect(isRetriableSqliteError(err)).toBe(false);
    });
  });

  describe("withFinancialTransactionRetry execution", () => {
    it("successfully retries when SQLite_BUSY occurs on first two attempts", async () => {
      const op = vi
        .fn()
        .mockRejectedValueOnce(new Error("SQLITE_BUSY: database is locked"))
        .mockRejectedValueOnce(
          new Error("D1_ERROR: stepping, database is locked (5)"),
        )
        .mockResolvedValueOnce({ status: "committed" });

      const result = await withFinancialTransactionRetry(op, {
        baseDelayMs: 5,
        maxDelayMs: 20,
      });

      expect(result).toEqual({ status: "committed" });
      expect(op).toHaveBeenCalledTimes(3);
    });

    it("aborts immediately without retrying on fatal validation error", async () => {
      const fatalErr = new Prisma.PrismaClientValidationError(
        "Invalid syntax",
        {
          clientVersion: "6.19.1",
        },
      );
      const op = vi.fn().mockRejectedValue(fatalErr);

      await expect(
        withFinancialTransactionRetry(op, { baseDelayMs: 5 }),
      ).rejects.toThrow("Invalid syntax");

      expect(op).toHaveBeenCalledTimes(1);
    });

    it("exhausts retry budget after maxRetries attempts and surfaces original error", async () => {
      const busyErr = new Error("SQLITE_BUSY: database is locked");
      const op = vi.fn().mockRejectedValue(busyErr);

      await expect(
        withFinancialTransactionRetry(op, { maxRetries: 3, baseDelayMs: 2 }),
      ).rejects.toThrow("SQLITE_BUSY: database is locked");

      expect(op).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    });
  });
});
