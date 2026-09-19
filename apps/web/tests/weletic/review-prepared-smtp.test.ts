import {
  prepareNodeMailerEmail,
  sendViaNodeMailer,
} from "@dub/email/send-via-nodemailer";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ create: vi.fn(), send: vi.fn() }));
vi.mock("../../../../packages/email/node_modules/nodemailer", () => ({
  default: { createTransport: transport.create },
}));
beforeEach(() => {
  vi.clearAllMocks();
  transport.create.mockReturnValue({ sendMail: transport.send });
  transport.send.mockResolvedValue({ messageId: "synthetic" });
  vi.stubEnv("SMTP_HOST", "localhost");
  vi.stubEnv("SMTP_PORT", "1025");
  vi.stubEnv("SMTP_USER", "");
  vi.stubEnv("SMTP_PASSWORD", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("prepared SMTP rendering (mocked transport)", () => {
  it("preserves prepared bytes, no-reply policy and plaintext without rendering again", async () => {
    const prepared = await prepareNodeMailerEmail({
      to: "shopper@example.test",
      from: "reviews@example.test",
      replyTo: "noreply",
      subject: "Saved",
      text: "Saved plaintext",
      react: createElement("p", null, "Saved <private> content"),
    });
    expect(transport.create).not.toHaveBeenCalled();
    expect(prepared.html).toContain("Saved &lt;private&gt; content");
    expect(prepared).not.toHaveProperty("react");
    expect(prepared).not.toHaveProperty("replyTo");
    await sendViaNodeMailer(prepared);
    expect(transport.send).toHaveBeenCalledExactlyOnceWith(prepared);
  });
  it("retains legacy React rendering and explicit reply-to behavior", async () => {
    await sendViaNodeMailer({
      to: "shopper@example.test",
      replyTo: "reply@example.test",
      subject: "Legacy",
      react: createElement("p", null, "Legacy"),
    });
    expect(transport.send.mock.calls[0][0]).toMatchObject({
      from: "noreply@example.com",
      replyTo: "reply@example.test",
      html: expect.stringContaining("Legacy"),
    });
  });
  it("rejects invalid SMTP configuration before entering the transport", async () => {
    vi.stubEnv("SMTP_PORT", "0");
    await expect(
      sendViaNodeMailer({
        to: "shopper@example.test",
        subject: "Saved",
        html: "<p>Saved</p>",
      }),
    ).rejects.toThrow("SMTP_PORT");
    expect(transport.create).not.toHaveBeenCalled();
  });
});
