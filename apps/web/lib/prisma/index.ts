import { PrismaClient } from "@prisma/client";

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
