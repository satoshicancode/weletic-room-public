import {
  openReviewDeliverySnapshot,
  sealReviewDeliverySnapshot,
} from "@/lib/weletic/reviews/delivery-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const context = {
  storeId: "store",
  requestId: "invitation",
  installationGeneration: "g1",
  tokenHash: "a".repeat(64),
  policyDigest: "b".repeat(64),
  recipient: "shopper@example.test",
  transportIdentity: "e".repeat(64),
};
const content = {
  to: context.recipient,
  from: "Weletic <reviews@example.test>",
  subject: "Your invitation",
  text: "10 points",
  html: "<p>10 points</p>",
};
const now = new Date("2026-09-20T00:00:00Z");
const seal = () =>
  sealReviewDeliverySnapshot({ context, content, provider: "resend", now });
const open = (
  ciphertext: string,
  overrides: Partial<Parameters<typeof openReviewDeliverySnapshot>[0]> = {},
) =>
  openReviewDeliverySnapshot({
    ciphertext,
    context,
    provider: "resend",
    now,
    retry: true,
    ...overrides,
  });
beforeEach(() => vi.stubEnv("ENCRYPTION_KEY", "37".repeat(32)));
afterEach(() => vi.unstubAllEnvs());

describe("private immutable review email evidence", () => {
  it("retains rendered bytes and provider identity without cleartext PII", () => {
    const ciphertext = seal();
    expect(ciphertext).not.toContain(context.recipient);
    expect(ciphertext).not.toContain(content.html);
    expect(open(ciphertext)).toEqual({
      content,
      providerKey: "native-review-request:invitation",
      retryUntil: new Date("2026-09-20T23:00:00.000Z"),
    });
  });
  it("does not depend on current template, branding or locale when reopening", () => {
    const draft = { ...content };
    const ciphertext = sealReviewDeliverySnapshot({
      context,
      content: draft,
      provider: "resend",
      now,
    });
    draft.html = "<p>Changed promise</p>";
    draft.subject = "Changed brand";
    expect(open(ciphertext).content).toEqual(content);
  });
  it.each([
    { storeId: "foreign" },
    { requestId: "foreign" },
    { installationGeneration: "g2" },
    { recipient: "other@example.test" },
    { tokenHash: "c".repeat(64) },
    { policyDigest: "d".repeat(64) },
    { policyDigest: null },
    { transportIdentity: "f".repeat(64) },
  ])("rejects changed authority %j", (patch) => {
    expect(() => open(seal(), { context: { ...context, ...patch } })).toThrow(
      "Review delivery evidence is unavailable",
    );
  });
  it("refuses ciphertext tampering and provider switching", () => {
    const ciphertext = seal();
    const tampered = Buffer.from(ciphertext, "base64");
    tampered[0] ^= 1;
    expect(() => open(tampered.toString("base64"))).toThrow();
    expect(() => open(ciphertext, { provider: "smtp" })).toThrow();
    expect(() => open("not encrypted")).toThrow();
  });
  it("rejects missing runtime retry classification", () => {
    expect(() =>
      open(seal(), { retry: undefined as unknown as boolean }),
    ).toThrow();
  });
  it.each([-1, 23 * 60 * 60 * 1000, Number.NaN])(
    "rejects invalid or unsafe retry age %s",
    (age) => {
      expect(() =>
        open(seal(), { now: new Date(now.getTime() + age) }),
      ).toThrow();
    },
  );
  it("allows a retry inside the conservative provider window", () => {
    expect(
      open(seal(), { now: new Date(now.getTime() + 23 * 60 * 60 * 1000 - 1) })
        .content,
    ).toEqual(content);
  });
  it("never automatically retries or switches an ambiguous SMTP attempt", () => {
    const ciphertext = sealReviewDeliverySnapshot({
      context,
      content,
      provider: "smtp",
      now,
    });
    expect(
      open(ciphertext, { provider: "smtp", retry: false }).content,
    ).toEqual(content);
    expect(() => open(ciphertext, { provider: "smtp" })).toThrow();
    expect(() => open(ciphertext, { provider: "resend" })).toThrow();
  });
  it.each([
    { to: "foreign@example.test" },
    { subject: "Subject\r\nBcc: foreign@example.test" },
    { from: "Sender\nBcc: foreign@example.test" },
    { html: "x".repeat(500_001) },
  ])("rejects unsafe prepared content", (patch) => {
    expect(() =>
      sealReviewDeliverySnapshot({
        context,
        content: { ...content, ...patch },
        provider: "resend",
        now,
      }),
    ).toThrow("Review delivery evidence is unavailable");
  });
});
