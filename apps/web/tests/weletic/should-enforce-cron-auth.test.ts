import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { shouldEnforceCronAuth } from "@/lib/cron/should-enforce-cron-auth";

describe("shouldEnforceCronAuth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed in production even without VERCEL or the opt-in flag", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("WELETIC_ENFORCE_CRON_AUTH", "");
    expect(shouldEnforceCronAuth()).toBe(true);
  });

  it("enforces on Vercel and when explicitly opted in", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "1");
    expect(shouldEnforceCronAuth()).toBe(true);

    vi.stubEnv("VERCEL", "");
    vi.stubEnv("WELETIC_ENFORCE_CRON_AUTH", "1");
    expect(shouldEnforceCronAuth()).toBe(true);
  });

  it("keeps the local development bypass outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("WELETIC_ENFORCE_CRON_AUTH", "");
    expect(shouldEnforceCronAuth()).toBe(false);
  });
});
