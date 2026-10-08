import { PrismaClient } from "@prisma/client";

// Ensure BigInt serialization does not crash JSON.stringify in scripts and workers
if (!("toJSON" in BigInt.prototype)) {
  Object.defineProperty(BigInt.prototype, "toJSON", {
    value: function (this: bigint) {
      const num = Number(this);
      return Number.isSafeInteger(num) ? num : this.toString();
    },
    writable: true,
    configurable: true,
  });
}

const prismaClientSingleton = () =>
  new PrismaClient({
    omit: {
      user: { passwordHash: true },
    },
  });

type OmittedPrismaClient = ReturnType<typeof prismaClientSingleton>;

declare global {
  var prisma: OmittedPrismaClient | undefined;
}

export const prisma = globalThis.prisma ?? prismaClientSingleton();

if (process.env.NODE_ENV !== "production") {
  globalThis.prisma = prisma;
}

export const sanitizeFullTextSearch = (search: string) => {
  // remove unsupported characters for full text search
  return search.replace(/[*+\-()~@%<>!=?:]/g, "").trim();
};
