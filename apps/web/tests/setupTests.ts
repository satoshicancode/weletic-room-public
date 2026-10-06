import crypto from "node:crypto";
import { vi } from "vitest";

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

// Initialize Weletic RBAC plugin registrations for test environment
import "@/lib/weletic/rbac/register";
