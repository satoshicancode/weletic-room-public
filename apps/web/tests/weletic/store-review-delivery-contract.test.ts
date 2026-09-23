import {
  openStoreReviewDeliverySnapshot,
  sealStoreReviewDeliverySnapshot,
} from "@/lib/weletic/reviews/store-delivery-snapshot";
import {
  renderStoreReviewInvitationEmail,
  storeReviewAccountEntryUrl,
} from "@/lib/weletic/reviews/store-invitation-email-content";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const now = new Date("2026-09-23T00:00:00Z");
const context = {
  storeId: "store-1",
  requestId: `wstorereq_${"a".repeat(20)}`,
  installationGeneration: "generation-1",
  policyDigest: "b".repeat(64),
  recipient: "buyer@example.test",
  transportIdentity: "c".repeat(64),
};
const content = {
  to: context.recipient,
  from: "Weletic <reviews@example.test>",
  subject: "Store review",
  html: "<p>Saved promise</p>",
  text: "Saved promise",
};
const seal = (provider: "resend" | "smtp" = "resend") =>
  sealStoreReviewDeliverySnapshot({ context, content, provider, now });
const open = (
  ciphertext: string,
  patch: Partial<Parameters<typeof openStoreReviewDeliverySnapshot>[0]> = {},
) =>
  openStoreReviewDeliverySnapshot({
    ciphertext,
    context,
    provider: "resend",
    now,
    retry: true,
    ...patch,
  });

beforeEach(() => vi.stubEnv("ENCRYPTION_KEY", "37".repeat(32)));
afterEach(() => vi.unstubAllEnvs());

describe("store-review invitation delivery contract", () => {
  it.each([
    ["en", "Sign in and open Store Reviews"],
    ["ja", "ログインしてストアレビューを開く"],
    ["vi", "Đăng nhập và mở Đánh giá cửa hàng"],
  ] as const)(
    "renders %s without exposing an invitation token",
    (language, action) => {
      const result = renderStoreReviewInvitationEmail({
        language,
        brandName: "<Weletic>",
        logoUrl: null,
        accentColor: "#123456",
        url: storeReviewAccountEntryUrl("shop.myshopify.com"),
        disclosure: ["One reward per order"],
      });
      const html = renderToStaticMarkup(result.react);
      expect(result.text).toContain(action);
      expect(result.text).toContain("https://shop.myshopify.com/account");
      expect(result.text).toContain("One reward per order");
      expect(result.text).not.toContain("#token=");
      expect(html).toContain(`lang="${language}"`);
      expect(html).toContain(action);
      expect(html).toContain("&lt;Weletic&gt;");
    },
  );

  it("rejects an untrusted account destination domain", () => {
    for (const domain of [
      "attacker.example",
      "shop.myshopify.com.evil.example",
      "shop.myshopify.com/account",
    ])
      expect(() => storeReviewAccountEntryUrl(domain)).toThrow();
  });

  it("retains exact provider bytes and a distinct store source key", () => {
    const ciphertext = seal();
    expect(ciphertext).not.toContain(context.recipient);
    expect(ciphertext).not.toContain(content.html);
    expect(open(ciphertext)).toEqual({
      content,
      providerKey: `native-store-review-request:${context.requestId}`,
      retryUntil: new Date("2026-09-23T23:00:00Z"),
    });
  });

  it.each([
    { storeId: "other-store" },
    { requestId: `wstorereq_${"z".repeat(20)}` },
    { installationGeneration: "generation-2" },
    { policyDigest: null },
    { recipient: "other@example.test" },
    { transportIdentity: "d".repeat(64) },
  ])("rejects changed delivery authority %j", (patch) => {
    expect(() => open(seal(), { context: { ...context, ...patch } })).toThrow(
      "Store-review delivery evidence unavailable",
    );
  });

  it("rejects provider switching, expired retry and ambiguous SMTP", () => {
    const ciphertext = seal();
    expect(() => open(ciphertext, { provider: "smtp" })).toThrow();
    expect(() =>
      open(ciphertext, { now: new Date(now.getTime() + 23 * 60 * 60_000) }),
    ).toThrow();
    const smtp = seal("smtp");
    expect(open(smtp, { provider: "smtp", retry: false }).content).toEqual(
      content,
    );
    expect(() => open(smtp, { provider: "smtp" })).toThrow();
  });
});
