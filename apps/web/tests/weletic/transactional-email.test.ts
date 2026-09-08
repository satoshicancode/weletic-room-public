import { getWeleticTransactionalEmailOptions } from "@/lib/weletic/transactional-email";
import net from "node:net";
import tls from "node:tls";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendBatchEmail, sendEmail } from "../../../../packages/email/src";

const transport = vi.hoisted(() => ({
  useResend: false,
  single: vi.fn(),
  batch: vi.fn(),
  smtp: vi.fn(),
  createTransport: vi.fn(),
  render: vi.fn(),
  pretty: vi.fn(),
}));

vi.mock("../../../../packages/email/src/resend", () => ({
  get resend() {
    return transport.useResend
      ? {
          emails: { send: transport.single },
          batch: { send: transport.batch },
        }
      : null;
  },
}));

// Resolve from the email package so monorepo dependency resolution cannot bind
// the mock to a different Nodemailer installation.
vi.mock("../../../../packages/email/node_modules/nodemailer", () => ({
  default: { createTransport: transport.createTransport },
}));

vi.mock("../../../../packages/email/node_modules/@react-email/render", () => ({
  render: transport.render,
  pretty: transport.pretty,
}));

const from = "Weletic <rewards@example.com>";
const replyTo = "Customer Support <support@example.com>";
const message = {
  to: "customer@example.com",
  subject: "Your reward",
  text: "Reward information",
};

beforeEach(() => {
  vi.clearAllMocks();
  const denyNetwork = () => {
    throw new Error("Unexpected network access in email adapter tests.");
  };
  vi.spyOn(net, "connect").mockImplementation(denyNetwork);
  vi.spyOn(tls, "connect").mockImplementation(denyNetwork);
  vi.spyOn(globalThis, "fetch").mockImplementation(denyNetwork);
  transport.useResend = false;
  transport.createTransport.mockReturnValue({ sendMail: transport.smtp });
  transport.smtp.mockResolvedValue({ messageId: "smtp-message" });
  transport.single.mockResolvedValue({
    data: { id: "resend-message" },
    error: null,
  });
  transport.batch.mockResolvedValue({
    data: { data: [{ id: "resend-message" }] },
    error: null,
  });
  transport.render.mockResolvedValue("<p>Reward information</p>");
  transport.pretty.mockImplementation(async (html: string) => html);
  for (const key of [
    "RESEND_API_KEY",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "VERCEL_ENV",
    "VERCEL_GIT_COMMIT_REF",
    "WELETIC_TRANSACTIONAL_EMAIL_FROM",
    "WELETIC_TRANSACTIONAL_EMAIL_REPLY_TO",
  ]) {
    vi.stubEnv(key, "");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Weletic transactional sender configuration", () => {
  it("preserves unconfigured development compatibility", () => {
    expect(getWeleticTransactionalEmailOptions({})).toEqual({});
  });

  it.each([
    "localhost",
    "127.0.0.1",
    "::1",
    "[::1]",
    "mailhog",
    "mailpit",
    " LOCALHOST ",
  ])(
    "allows the local capture transport %s without an external sender",
    (SMTP_HOST) => {
      expect(getWeleticTransactionalEmailOptions({ SMTP_HOST })).toEqual({});
    },
  );

  it.each([
    { RESEND_API_KEY: "test-key" },
    { SMTP_HOST: "smtp.example.com" },
    { SMTP_HOST: "localhost.example.com" },
    { SMTP_HOST: "localhost", RESEND_API_KEY: "test-key" },
  ])("requires a sender for the selected external transport %j", (env) => {
    expect(() => getWeleticTransactionalEmailOptions(env)).toThrow(
      "WELETIC_TRANSACTIONAL_EMAIL_FROM is required",
    );
  });

  it("validates and trims explicit single mailboxes", () => {
    expect(
      getWeleticTransactionalEmailOptions({
        RESEND_API_KEY: "test-key",
        WELETIC_TRANSACTIONAL_EMAIL_FROM: ` ${from} `,
        WELETIC_TRANSACTIONAL_EMAIL_REPLY_TO: ` ${replyTo} `,
      }),
    ).toEqual({ from, replyTo });
  });

  it("suppresses the shared Dub reply-to when only Weletic FROM is configured", () => {
    expect(
      getWeleticTransactionalEmailOptions({
        WELETIC_TRANSACTIONAL_EMAIL_FROM: "rewards@example.com",
      }),
    ).toEqual({ from: "rewards@example.com", replyTo: "noreply" });
  });

  it.each([
    "not-a-mailbox",
    "one@example.com, two@example.com",
    "one@example.com, Team <two@example.com>",
    "one@example.com; Team <two@example.com>",
    "Team <one@example.com> <two@example.com>",
    "Team <one@example.com>\r\nBcc: two@example.com",
    "Team\u0000 <one@example.com>",
  ])(
    "rejects malformed or multiple sender mailboxes without exposing them",
    (value) => {
      expect(() =>
        getWeleticTransactionalEmailOptions({
          WELETIC_TRANSACTIONAL_EMAIL_FROM: value,
        }),
      ).toThrow(
        "WELETIC_TRANSACTIONAL_EMAIL_FROM must contain one valid email mailbox.",
      );
    },
  );

  it("also validates reply-to and allows a local-only reply-to override", () => {
    expect(() =>
      getWeleticTransactionalEmailOptions({
        WELETIC_TRANSACTIONAL_EMAIL_FROM: from,
        WELETIC_TRANSACTIONAL_EMAIL_REPLY_TO: "noreply",
      }),
    ).toThrow(
      "WELETIC_TRANSACTIONAL_EMAIL_REPLY_TO must contain one valid email mailbox.",
    );
    expect(
      getWeleticTransactionalEmailOptions({
        SMTP_HOST: "localhost",
        WELETIC_TRANSACTIONAL_EMAIL_REPLY_TO: replyTo,
      }),
    ).toEqual({ replyTo });
  });
});

describe("production email transport adapters (mocked network)", () => {
  it.each(["single", "batch"] as const)(
    "forwards Weletic sender and reply-to through Resend %s",
    async (mode) => {
      transport.useResend = true;
      const options = {
        ...message,
        ...getWeleticTransactionalEmailOptions({
          RESEND_API_KEY: "test-key",
          WELETIC_TRANSACTIONAL_EMAIL_FROM: from,
          WELETIC_TRANSACTIONAL_EMAIL_REPLY_TO: replyTo,
        }),
      };
      if (mode === "single") {
        await sendEmail(options);
        expect(transport.single).toHaveBeenCalledWith(
          expect.objectContaining({ ...message, from, replyTo }),
        );
      } else {
        await sendBatchEmail([options], {
          idempotencyKey: "review-request:test",
        });
        expect(transport.batch).toHaveBeenCalledWith(
          [expect.objectContaining({ ...message, from, replyTo })],
          { idempotencyKey: "review-request:test" },
        );
      }
      expect(transport.smtp).not.toHaveBeenCalled();
    },
  );

  it.each(["single", "batch"] as const)(
    "forwards Weletic sender and reply-to through SMTP %s",
    async (mode) => {
      vi.stubEnv("SMTP_HOST", "smtp.example.com");
      vi.stubEnv("SMTP_PORT", "587");
      const options = {
        ...message,
        ...getWeleticTransactionalEmailOptions({
          SMTP_HOST: "smtp.example.com",
          WELETIC_TRANSACTIONAL_EMAIL_FROM: from,
          WELETIC_TRANSACTIONAL_EMAIL_REPLY_TO: replyTo,
        }),
      };
      if (mode === "single") await sendEmail(options);
      else
        expect(await sendBatchEmail([options])).toMatchObject({
          error: null,
          data: { data: [{ id: expect.any(String) }] },
        });
      expect(transport.smtp).toHaveBeenCalledExactlyOnceWith({
        ...message,
        from,
        replyTo,
      });
      expect(transport.createTransport).toHaveBeenCalledWith({
        host: "smtp.example.com",
        port: 587,
        secure: false,
        tls: { rejectUnauthorized: true },
      });
      expect(transport.render).not.toHaveBeenCalled();
    },
  );

  it.each(["resend", "smtp"])(
    "never falls back to Dub support for Weletic %s delivery",
    async (provider) => {
      transport.useResend = provider === "resend";
      vi.stubEnv("SMTP_HOST", "smtp.example.com");
      vi.stubEnv("SMTP_PORT", "587");
      await sendBatchEmail([
        {
          ...message,
          ...getWeleticTransactionalEmailOptions({
            WELETIC_TRANSACTIONAL_EMAIL_FROM: from,
          }),
        },
      ]);
      const delivered =
        provider === "resend"
          ? transport.batch.mock.calls[0][0][0]
          : transport.smtp.mock.calls[0][0];
      expect(delivered).toMatchObject({ from });
      expect(delivered).not.toHaveProperty("replyTo");
    },
  );

  it("preserves unrelated Dub Resend defaults", async () => {
    transport.useResend = true;
    await sendEmail({ ...message, variant: "notifications" });
    expect(transport.single).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Dub.co <notifications@mail.dub.co>",
        replyTo: "support@dub.co",
      }),
    );
  });

  it("preserves the local capture sender and supports React HTML", async () => {
    vi.stubEnv("SMTP_HOST", "localhost");
    vi.stubEnv("SMTP_PORT", "1025");
    const react = createElement("p", null, "Reward information");
    await sendEmail({ ...message, react });
    expect(transport.smtp).toHaveBeenCalledWith({
      ...message,
      from: "noreply@example.com",
      html: "<p>Reward information</p>",
    });
    expect(transport.render).toHaveBeenCalledWith(react);
  });

  it("uses implicit TLS on 465 with supplied credentials and certificate verification", async () => {
    vi.stubEnv("SMTP_HOST", "smtp.example.com");
    vi.stubEnv("SMTP_PORT", "465");
    vi.stubEnv("SMTP_USER", "test-user");
    vi.stubEnv("SMTP_PASSWORD", "test-password");
    await sendEmail({ ...message, from });
    expect(transport.createTransport).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      auth: { user: "test-user", pass: "test-password" },
      tls: { rejectUnauthorized: true },
    });
  });

  it.each(["0", "65536", "NaN", "1025.5"])(
    "rejects invalid SMTP port %s before network access",
    async (port) => {
      vi.stubEnv("SMTP_HOST", "localhost");
      vi.stubEnv("SMTP_PORT", port);
      await expect(sendBatchEmail([{ ...message, from }])).rejects.toThrow(
        "SMTP_PORT must be an integer between 1 and 65535.",
      );
      expect(transport.createTransport).not.toHaveBeenCalled();
      expect(transport.smtp).not.toHaveBeenCalled();
    },
  );

  it("does not claim delivery when no transport exists", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    expect(await sendBatchEmail([message])).toEqual({
      data: null,
      error: null,
    });
    expect(transport.smtp).not.toHaveBeenCalled();
    expect(transport.batch).not.toHaveBeenCalled();
  });
});
