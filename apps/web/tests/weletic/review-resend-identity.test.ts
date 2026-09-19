import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllEnvs());

describe("actual Resend singleton credential identity (no sends)", () => {
  it("keeps its construction identity and rejects environment rotation", async () => {
    vi.stubEnv("RESEND_API_KEY", "synthetic-initial");
    const client = await import("@dub/email/resend/client");
    const expected = createHash("sha256")
      .update(JSON.stringify(["resend-credential-v1", "synthetic-initial"]))
      .digest("hex");
    expect(client.resend).not.toBeNull();
    expect(client.resendCredentialIdentity).toBe(expected);
    expect(client.isResendCredentialCurrent()).toBe(true);
    vi.stubEnv("RESEND_API_KEY", "synthetic-rotated");
    expect(client.resendCredentialIdentity).toBe(expected);
    expect(client.isResendCredentialCurrent()).toBe(false);
  });
  it("does not fabricate an identity when there was no configured client", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const client = await import("@dub/email/resend/client");
    expect(client.resend).toBeNull();
    expect(client.resendCredentialIdentity).toBeNull();
    expect(client.isResendCredentialCurrent()).toBe(false);
    vi.stubEnv("RESEND_API_KEY", "synthetic-later");
    expect(client.isResendCredentialCurrent()).toBe(false);
  });
});
