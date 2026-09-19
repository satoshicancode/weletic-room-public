import {
  dispatchPreparedReviewEmail,
  prepareReviewEmail,
} from "@/lib/weletic/reviews/prepared-email";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  enabled: true,
  send: vi.fn(),
  smtp: vi.fn(),
}));
vi.mock("@dub/email/resend", () => ({
  resendCredentialIdentity: "e".repeat(64),
  isResendCredentialCurrent: () =>
    process.env.RESEND_API_KEY === "synthetic-key",
  get resend() {
    return transport.enabled ? { batch: { send: transport.send } } : null;
  },
}));
vi.mock("@dub/email/send-via-nodemailer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dub/email/send-via-nodemailer")>()),
  sendViaNodeMailer: transport.smtp,
}));

const draft = {
  email: "shopper@example.test",
  language: "en" as const,
  productTitle: "Saved product",
  brandName: "Saved brand",
  logoUrl: null,
  accentColor: "#000000",
  disclosure: ["No reward is offered."],
  url: "https://synthetic.myshopify.com/apps/weletic/reviews/write#token=synthetic",
};
const key = "native-review-request:invitation";
beforeEach(() => {
  vi.clearAllMocks();
  transport.enabled = true;
  transport.send.mockResolvedValue({
    data: { data: [{ id: "synthetic" }] },
    error: null,
  });
  transport.smtp.mockResolvedValue({ messageId: "synthetic" });
  vi.stubEnv("VERCEL_ENV", "test");
  vi.stubEnv("RESEND_API_KEY", "synthetic-key");
  vi.stubEnv(
    "WELETIC_TRANSACTIONAL_EMAIL_FROM",
    "Weletic <reviews@example.test>",
  );
  vi.stubEnv("WELETIC_TRANSACTIONAL_EMAIL_REPLY_TO", "");
  vi.stubEnv("SMTP_HOST", "localhost");
  vi.stubEnv("SMTP_PORT", "1025");
});
afterEach(() => vi.unstubAllEnvs());

describe("prepared review provider boundary (mocked transports)", () => {
  it("refuses preparation if the environment no longer matches the constructed client", async () => {
    vi.stubEnv("RESEND_API_KEY", "changed-before-preparation");
    await expect(prepareReviewEmail(draft)).rejects.toThrow(
      "transport unavailable",
    );
    expect(transport.send).not.toHaveBeenCalled();
    expect(transport.smtp).not.toHaveBeenCalled();
  });
  it("prepares without sending and reuses exact normalized content after configuration changes", async () => {
    const prepared = await prepareReviewEmail(draft);
    expect(transport.send).not.toHaveBeenCalled();
    expect(transport.smtp).not.toHaveBeenCalled();
    expect(prepared.provider).toBe("resend");
    expect(prepared.content).not.toHaveProperty("react");
    expect(prepared.content).not.toHaveProperty("replyTo");
    expect(prepared.content.html).toContain("Saved product");
    vi.stubEnv("WELETIC_TRANSACTIONAL_EMAIL_FROM", "changed@example.test");
    vi.stubEnv("VERCEL_ENV", "preview");
    await dispatchPreparedReviewEmail({ ...prepared, providerKey: key });
    await dispatchPreparedReviewEmail({ ...prepared, providerKey: key });
    expect(transport.send.mock.calls).toEqual([
      [[prepared.content], { idempotencyKey: key }],
      [[prepared.content], { idempotencyKey: key }],
    ]);
  });
  it("rejects preview recipient redirection before retaining an invitation", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    await expect(prepareReviewEmail(draft)).rejects.toThrow(
      "transport unavailable",
    );
    expect(transport.send).not.toHaveBeenCalled();
  });
  it("does not fall back to SMTP when the retained Resend transport disappears", async () => {
    const prepared = await prepareReviewEmail(draft);
    transport.enabled = false;
    await expect(
      dispatchPreparedReviewEmail({ ...prepared, providerKey: key }),
    ).rejects.toThrow("transport unavailable");
    expect(transport.smtp).not.toHaveBeenCalled();
  });
  it.each(["resend", "smtp"] as const)(
    "blocks %s credential changes before dispatch",
    async (provider) => {
      transport.enabled = provider === "resend";
      const prepared = await prepareReviewEmail(draft);
      vi.stubEnv(
        provider === "resend" ? "RESEND_API_KEY" : "SMTP_PASSWORD",
        "changed-credential",
      );
      await expect(
        dispatchPreparedReviewEmail({ ...prepared, providerKey: key }),
      ).rejects.toThrow("transport unavailable");
      expect(transport.send).not.toHaveBeenCalled();
      expect(transport.smtp).not.toHaveBeenCalled();
      expect(prepared.transportIdentity).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(prepared)).not.toContain("synthetic-key");
    },
  );
  it("pins SMTP and passes rendered HTML rather than mutable React props", async () => {
    transport.enabled = false;
    const prepared = await prepareReviewEmail(draft);
    expect(prepared.provider).toBe("smtp");
    expect(prepared.content.html).toContain("Saved product");
    expect(prepared.content.text).toContain("No reward is offered.");
    transport.enabled = true;
    await dispatchPreparedReviewEmail({ ...prepared, providerKey: key });
    expect(transport.smtp).toHaveBeenCalledExactlyOnceWith(prepared.content);
    expect(transport.send).not.toHaveBeenCalled();
  });
  it("fails closed without configured transport or an approved external sender", async () => {
    transport.enabled = false;
    vi.stubEnv("SMTP_HOST", "");
    await expect(prepareReviewEmail(draft)).rejects.toThrow(
      "transport unavailable",
    );
    vi.stubEnv("SMTP_HOST", "smtp.example.test");
    vi.stubEnv("WELETIC_TRANSACTIONAL_EMAIL_FROM", "");
    await expect(prepareReviewEmail(draft)).rejects.toThrow(
      "transport unavailable",
    );
  });
  it("rejects missing provider keys and hides provider errors containing private data", async () => {
    const prepared = await prepareReviewEmail(draft);
    await expect(
      dispatchPreparedReviewEmail({ ...prepared, providerKey: "" }),
    ).rejects.toThrow("transport unavailable");
    expect(transport.send).not.toHaveBeenCalled();
    transport.send.mockRejectedValue(new Error(draft.email + draft.url));
    await expect(
      dispatchPreparedReviewEmail({ ...prepared, providerKey: key }),
    ).rejects.toThrow(/^Review email transport unavailable$/);
  });
});
