import { prepareResendEmail, sendPreparedResendEmail } from "@dub/email";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@dub/email/resend", () => ({
  resend: { batch: { send: transport.send } },
}));

describe("prepared expiry email provider boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transport.send.mockResolvedValue({
      data: { data: [{ id: "synthetic" }] },
      error: null,
    });
  });
  afterEach(() => vi.unstubAllEnvs());
  it("renders and normalizes once, then sends the exact saved request despite environment changes", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "fixture-branch");
    const prepared = await prepareResendEmail({
      to: "synthetic@example.com",
      from: "Weletic <test@example.com>",
      replyTo: "noreply",
      subject: "Saved",
      variant: "marketing",
      unsubscribeUrl: "https://synthetic.myshopify.com/account/profile",
      react: createElement("p", null, "Saved <customer> text"),
    });
    expect(prepared).not.toHaveProperty("react");
    expect(prepared.to).toBe("delivered@resend.dev");
    expect(prepared.subject).toBe("Saved [fixture-branch]");
    expect(prepared.html).toContain("Saved &lt;customer&gt; text");
    expect(prepared.headers).toEqual({
      "List-Unsubscribe": "https://synthetic.myshopify.com/account/profile",
    });
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "another-branch");
    await sendPreparedResendEmail(prepared, "stable-key");
    await sendPreparedResendEmail(prepared, "stable-key");
    expect(transport.send).toHaveBeenCalledTimes(2);
    expect(transport.send.mock.calls[0]).toEqual([
      [prepared],
      { idempotencyKey: "stable-key" },
    ]);
    expect(transport.send.mock.calls[1]).toEqual(transport.send.mock.calls[0]);
  });
  it("refuses to send without a stable idempotency key", async () => {
    await expect(
      sendPreparedResendEmail(
        {
          to: "synthetic@example.com",
          from: "test@example.com",
          subject: "Saved",
          html: "<p>Saved</p>",
        },
        "",
      ),
    ).rejects.toThrow("transport unavailable");
    expect(transport.send).not.toHaveBeenCalled();
  });
});
