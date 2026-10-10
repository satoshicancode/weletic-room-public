/// <reference types="@cloudflare/workers-types" />
import { PrismaClient } from "@prisma/client";
import { PrismaD1 } from "@prisma/adapter-d1";
import { ALL_ENUMS } from "../types/enums";
import * as prismaClientModule from "@prisma/client";

// Fail-safe in-memory patch for runtime enums
try {
  Object.assign(prismaClientModule, ALL_ENUMS);
  if ((prismaClientModule as any).$Enums) {
    Object.assign((prismaClientModule as any).$Enums, ALL_ENUMS);
  }
} catch {
  // Ignore in read-only / frozen environments
}

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

declare global {
  // Ensures D1Database is recognized as an ambient type if workers-types is bypassed
  interface D1DatabaseSession {}
}

export function createPrismaClient(d1Database?: D1Database) {
  if (d1Database) {
    const adapter = new PrismaD1(d1Database);
    return new PrismaClient({
      adapter,
      omit: {
        user: { passwordHash: true },
      },
    });
  }

  // Fallback to built-in SQLite engine for Node.js / Next dev / Vitest
  return new PrismaClient({
    omit: {
      user: { passwordHash: true },
    },
  });
}

export type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;

declare global {
  var prisma: ExtendedPrismaClient | undefined;
  var DB: D1Database | undefined;
  var __boundD1: D1Database | undefined;
}

let fallbackPrisma: ExtendedPrismaClient | undefined;

function getActiveClient(): ExtendedPrismaClient {
  const candidate = (globalThis as any).prisma;
  if (candidate && candidate !== prismaProxy) {
    return candidate;
  }
  const d1 = (globalThis as any).DB as D1Database | undefined;
  if (d1) {
    if (!fallbackPrisma || (globalThis as any).__boundD1 !== d1) {
      fallbackPrisma = createPrismaClient(d1);
      (globalThis as any).__boundD1 = d1;
    }
    return fallbackPrisma;
  }
  if (!fallbackPrisma) {
    fallbackPrisma = createPrismaClient();
  }
  return fallbackPrisma;
}

const prismaProxy: ExtendedPrismaClient = new Proxy({} as ExtendedPrismaClient, {
  get(target, prop, receiver) {
    if (Reflect.has(target, prop)) {
      return Reflect.get(target, prop, receiver);
    }
    const client = getActiveClient();
    const value = Reflect.get(client, prop);
    return typeof value === "function" ? value.bind(client) : value;
  },
  set(target, prop, value) {
    const client = getActiveClient();
    Reflect.set(target, prop, value);
    return Reflect.set(client, prop, value);
  },
  defineProperty(target, prop, descriptor) {
    const client = getActiveClient();
    try {
      Object.defineProperty(client, prop, descriptor);
    } catch {
      // Ignore if client is non-configurable
    }
    return Reflect.defineProperty(target, prop, descriptor);
  },
  getOwnPropertyDescriptor(target, prop) {
    if (Reflect.has(target, prop)) {
      return Object.getOwnPropertyDescriptor(target, prop);
    }
    const client = getActiveClient();
    return Object.getOwnPropertyDescriptor(client, prop);
  },
  has(target, prop) {
    if (Reflect.has(target, prop)) {
      return true;
    }
    const client = getActiveClient();
    return Reflect.has(client, prop);
  },
  getPrototypeOf() {
    return Object.getPrototypeOf(getActiveClient());
  },
});

export const prisma = prismaProxy;

if (process.env.NODE_ENV !== "production") {
  if (!globalThis.prisma) {
    globalThis.prisma = prisma;
  }
}

export const sanitizeFullTextSearch = (search: string) => {
  // remove unsupported characters for full text search
  return search.replace(/[*+\-()~@%<>!=?:]/g, "").trim();
};
