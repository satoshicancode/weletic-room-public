import { prepareResendEmail, sendPreparedResendEmail } from "@dub/email";
import ReferralFriendReward, {
  referralConfirmationCopy,
} from "@dub/email/templates/referral-friend-reward";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  available: true,
  smtp: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@dub/email/resend", () => ({
  get resend() {
    return transport.available ? { batch: { send: transport.send } } : null;
  },
}));
vi.mock("@dub/email/send-via-nodemailer", () => ({
  sendViaNodeMailer: transport.smtp,
}));
beforeEach(() => {
  transport.available = true;
  vi.clearAllMocks();
});
async function render(react: ReactElement) {
  const prepared = await prepareResendEmail({
    to: "fixture@example.test",
    from: "Weletic <loyalty@example.test>",
    replyTo: "noreply",
    subject: "Requested reward",
    variant: "notifications",
    react,
  });
  return prepared.html;
}

describe("requested anonymous confirmation fixed localizations", () => {
  it("does not fall back to SMTP when Resend is unavailable", async () => {
    transport.available = false;
    await expect(
      sendPreparedResendEmail(
        {
          to: "fixture@example.test",
          from: "loyalty@example.test",
          subject: "Requested reward",
          html: "<p>test</p>",
        },
        "fixture-key",
      ),
    ).rejects.toThrow("unavailable");
    expect(transport.smtp).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
  });
  it.each(["en", "ja", "vi"] as const)(
    "renders %s service confirmation without invitation or private advocate details",
    async (locale) => {
      const html = await render(
        <ReferralFriendReward
          locale={locale}
          brandName="Weletic"
          advocateName="PRIVATE_ADVOCATE"
          rewardName="Coupon <script>"
          discountCode="TEST-CODE"
          applyUrl="https://fixture.myshopify.com/discount/TEST-CODE"
          expiresAt="2026-10-01"
        />,
      );
      expect(html).toContain(`lang="${locale}"`);
      expect(html).toContain(referralConfirmationCopy[locale].heading);
      expect(html).toContain(referralConfirmationCopy[locale].terms);
      expect(html).toContain(referralConfirmationCopy[locale].expiry);
      expect(html).toContain("Coupon &lt;script&gt;");
      expect(html).toContain("TEST-CODE");
      expect(html).not.toContain("PRIVATE_ADVOCATE");
      expect(html).not.toContain("sent you");
      expect(html).not.toContain("Join");
      expect(html).not.toContain("<script>");
    },
  );
});
