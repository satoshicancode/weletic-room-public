import crypto from "node:crypto";
import { vi } from "vitest";

process.env.ENCRYPTION_KEY ||=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.STORAGE_ENDPOINT ||=
  "https://00000000000000000000000000000000.r2.cloudflarestorage.com";
process.env.STORAGE_PUBLIC_BUCKET ||= "weletic-test-public";
process.env.STORAGE_PRIVATE_BUCKET ||= "weletic-test-private";
process.env.STORAGE_ACCESS_KEY_ID ||= "test-access-key";
process.env.STORAGE_SECRET_ACCESS_KEY ||= "test-secret-key";

vi.mock("server-only", () => ({}));

Object.defineProperty(globalThis, "crypto", {
  value: crypto,
  writable: false, // Ensure it's not writable
  configurable: true, // Allow reconfiguration if needed
});

// R3: Fail-fast network guard against real Upstash cloud calls during tests
const originalGlobalFetch = globalThis.fetch;
if (originalGlobalFetch) {
  globalThis.fetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const urlString =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input instanceof Request
            ? input.url
            : String(input);
    if (urlString.includes("upstash.io")) {
      throw new Error(
        `[R3 INVARIANT VIOLATION] Real network request to Upstash cloud blocked during test: ${urlString}`,
      );
    }
    return originalGlobalFetch(input, init);
  };
}

// Mock Axiom SDK modules to prevent initialization issues during tests
vi.mock("@axiomhq/js", () => ({
  Axiom: class {
    constructor(_config: any) {}
    ingest = vi.fn().mockResolvedValue(undefined);
    query = vi.fn().mockResolvedValue({ matches: [] });
  },
}));

vi.mock("@axiomhq/logging", () => ({
  AxiomJSTransport: class {
    constructor(_config: any) {}
  },
  ConsoleTransport: class {
    constructor(_config?: any) {}
  },
  Logger: class {
    constructor(_config: any) {}
    log = vi.fn();
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    flush = vi.fn().mockResolvedValue(undefined);
  },
  LogLevel: {
    info: "info",
    warn: "warn",
    error: "error",
  },
}));

vi.mock("@axiomhq/nextjs", () => ({
  createAxiomRouteHandler: vi.fn((logger, options) => {
    return (handler: any) => handler;
  }),
  nextJsFormatters: {},
  transformRouteHandlerSuccessResult: vi.fn(() => ["", {}]),
  createOnRequestError: vi.fn(() => vi.fn()),
  transformMiddlewareRequest: vi.fn(() => []),
}));

// Mock rateLimitRequest to prevent hitting real or blocked Upstash pipeline during route handler tests
vi.mock("@/lib/auth/rate-limit-request", () => ({
  rateLimitRequest: vi.fn(async () => ({
    success: true,
    headers: {},
  })),
}));

// Initialize Weletic RBAC plugin registrations for test environment
import "@/lib/weletic/rbac/register";

// Runtime enum export fail-safe for Vitest
try {
  const prismaClient = require("@prisma/client");
  const { ALL_ENUMS } = require("@/lib/types/enums");
  Object.assign(prismaClient, ALL_ENUMS);
  if (prismaClient.$Enums) {
    Object.assign(prismaClient.$Enums, ALL_ENUMS);
  }
  // Intentionally no Prisma.TransactionIsolationLevel patching: only
  // Serializable is supported by the SQLite engine and by our code.
} catch {
  // Handled
}
