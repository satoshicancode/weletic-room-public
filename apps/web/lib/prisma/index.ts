/// <reference types="@cloudflare/workers-types" />
import { PrismaD1 } from "@prisma/adapter-d1";
import * as prismaClientModule from "@prisma/client";
import { PrismaClient } from "@prisma/client";
import { ALL_ENUMS } from "../types/enums";
import {
  isD1TransactionSemanticsEnabled,
  withD1TransactionSemantics,
} from "./d1-semantics";
import { matchClockOnlyQuery, rewriteSql, rewriteUnsafe } from "./sql-dialect";

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

const clientOptions = {
  omit: {
    user: { passwordHash: true },
  },
} as const;

function normalizeWhereClause(where: any) {
  if (!where || typeof where !== "object") return;
  if (Array.isArray(where)) {
    for (const item of where) normalizeWhereClause(item);
    return;
  }
  if ("programId_partnerId" in where) {
    where.partnerId_programId = {
      partnerId: where.programId_partnerId.partnerId,
      programId: where.programId_partnerId.programId,
    };
    delete where.programId_partnerId;
  }
  for (const key of Object.keys(where)) {
    const val = where[key];
    if (val && typeof val === "object") {
      if ("array_contains" in val) {
        const target = val.array_contains;
        delete val.array_contains;
        const item = Array.isArray(target) ? target[0] : target;
        val.string_contains = `"${item}"`;
      } else {
        normalizeWhereClause(val);
      }
    }
  }
}

/**
 * Adapts MySQL-flavoured raw SQL (inherited from upstream Dub) to SQLite / D1.
 * See ./sql-dialect.ts. Interactive-transaction clients inherit the extension.
 */
function withSqlDialect<T extends PrismaClient<any, any, any>>(client: T): T {
  const extended = client.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: any) {
          if (args?.where) {
            normalizeWhereClause(args.where);
          }
          return query(args);
        },
        async createMany({ model, operation, args, query }: any) {
          if (args?.skipDuplicates) {
            const shouldSkip = args.skipDuplicates;
            delete args.skipDuplicates;
            if (shouldSkip) {
              try {
                return await query(args);
              } catch (err: any) {
                if (err.code === "P2002" || /unique constraint/i.test(err.message || "")) {
                  let count = 0;
                  const modelName = model.charAt(0).toLowerCase() + model.slice(1);
                  const delegate = (client as any)[modelName];
                  const data = Array.isArray(args.data) ? args.data : [args.data];
                  for (const item of data) {
                    try {
                      await delegate.create({ data: item });
                      count++;
                    } catch (itemErr: any) {
                      if (itemErr.code !== "P2002" && !/unique constraint/i.test(itemErr.message || "")) {
                        throw itemErr;
                      }
                    }
                  }
                  return { count };
                }
                throw err;
              }
            }
          }
          return query(args);
        },
      },
      $queryRaw({ args, query }: any) {
        const alias = matchClockOnlyQuery(args.strings?.join("?") ?? "");
        if (alias && (args.values?.length ?? 0) === 0) {
          return Promise.resolve([{ [alias]: new Date() }]);
        }
        return query(rewriteSql(args));
      },
      $executeRaw({ args, query }: any) {
        return query(rewriteSql(args));
      },
      $queryRawUnsafe({ args, query }: any) {
        const alias = matchClockOnlyQuery(String(args[0] ?? ""));
        if (alias && args.length === 1) {
          return Promise.resolve([{ [alias]: new Date() }]);
        }
        return query(rewriteUnsafe(args));
      },
      $executeRawUnsafe({ args, query }: any) {
        return query(rewriteUnsafe(args));
      },
    },
  });
  return extended as unknown as T;
}

export function createPrismaClient(d1Database?: D1Database) {
  if (d1Database) {
    const adapter = new PrismaD1(d1Database);
    return withSqlDialect(new PrismaClient({ adapter, ...clientOptions }));
  }

  // Next.js (Node) talking to the same D1 database over Cloudflare's HTTP API.
  const d1Http = getD1HttpConfig();
  if (d1Http) {
    return withSqlDialect(
      new PrismaClient({ adapter: new PrismaD1(d1Http), ...clientOptions }),
    );
  }

  const allowLocalSqlite =
    process.env.PLAYWRIGHT_TEST === "1" ||
    process.env.CI_SEPARATE_VALIDATION === "true" ||
    process.env.WELETIC_ALLOW_LOCAL_SQLITE === "1";

  if (
    process.env.NODE_ENV === "production" &&
    process.env.NEXT_PHASE !== "phase-production-build" &&
    !allowLocalSqlite
  ) {
    throw new Error(
      "[Prisma D1 Configuration Fatal] Running in production requires valid Cloudflare D1 HTTP credentials " +
      "(CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_D1_API_TOKEN) or native D1 binding. " +
      "Silent fallback to local SQLite container is strictly prohibited.",
    );
  }

  // Fallback to built-in SQLite engine for local Node.js / Next dev / Vitest.
  // WELETIC_D1_TX_SEMANTICS=1 strips transaction atomicity so money flows are
  // exercised under the same rules as production D1 (see ./d1-semantics.ts).
  const local = withSqlDialect(new PrismaClient({ ...clientOptions }));
  return isD1TransactionSemanticsEnabled()
    ? withD1TransactionSemantics(local)
    : local;
}

/**
 * D1 over HTTP, for runtimes without a Workers binding (Next.js on Node).
 * Requires all three variables; otherwise the local SQLite engine is used.
 */
function getD1HttpConfig() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;
  const apiToken =
    process.env.CLOUDFLARE_D1_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !databaseId || !apiToken) return null;
  return {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_DATABASE_ID: databaseId,
    CLOUDFLARE_D1_TOKEN: apiToken,
  };
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

const prismaProxy: ExtendedPrismaClient = new Proxy(
  {} as ExtendedPrismaClient,
  {
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
  },
);

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
