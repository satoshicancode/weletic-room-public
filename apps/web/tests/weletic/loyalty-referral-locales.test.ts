/** @vitest-environment happy-dom */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const assets = path.resolve(
  __dirname,
  "../../../../packages/shopify-app/extensions/weletic-analytics/assets",
);
const shared = fs.readFileSync(
  path.join(assets, "weletic-loyalty-shared.js"),
  "utf8",
);
const widget = fs.readFileSync(
  path.join(assets, "weletic-loyalty-widget.js"),
  "utf8",
);
const copy = [
  [
    "en",
    "You were invited",
    "A friend sent you a reward",
    "Claim my reward",
    "Your reward is ready",
    "Claim received",
    "Unable to claim this reward.",
  ],
  [
    "ja",
    "友達からの招待",
    "友達から特典が届きました",
    "特典を受け取る",
    "特典をご利用いただけます",
    "お申し込みを受け付けました",
    "この特典を取得できませんでした。",
  ],
  [
    "vi",
    "Bạn được mời",
    "Bạn bè đã gửi phần thưởng cho bạn",
    "Nhận phần thưởng",
    "Phần thưởng đã sẵn sàng",
    "Đã nhận yêu cầu",
    "Không thể nhận phần thưởng này.",
  ],
];

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function mount(
  locale: string,
  kind: "points" | "coupon",
  claim: () => Promise<Response> = async () => response({ status: "review" }),
  sharing?: { guest?: boolean; link?: string | null },
) {
  document.documentElement.lang = locale;
  if (!sharing)
    window.sessionStorage.setItem("weletic_referral_code", "synthetic-invite");
  document.body.innerHTML = `<div data-weletic-loyalty-root data-shop="fixture.myshopify.com" data-logged-in="${Boolean(sharing && !sharing.guest)}"></div>`;
  Object.defineProperty(document, "readyState", {
    configurable: true,
    value: "complete",
  });
  const fetchMock = vi.fn(async (url: string) =>
    url.includes("/customer?")
      ? response({
          isEnrolled: true,
          account: {
            id: "PRIVATE_ACCOUNT",
            status: "active",
            canParticipate: true,
            pointsBalance: "0",
            pendingPoints: "0",
          },
          referral: { referralShareUrl: sharing?.link ?? null },
          program: { pointNameSingular: "Coin", pointNamePlural: "Coins" },
        })
      : url.endsWith("/referral/claim")
        ? claim()
        : response({
            program: {
              isActive: true,
              pointNameSingular: "Coin",
              pointNamePlural: "Coins",
            },
            branding: { enableFloatingLauncher: true },
            tiers: [],
            rewards: [],
            earningRules: [],
            referralOffer: {
              isActive: true,
              friendRewardKind: kind,
              friendPointsReward: "100",
              friendClaimEnabled: true,
              friendRewardName: "Merchant <b>reward</b>",
              advocateRewardKind: "points",
              advocatePointsReward: "200",
            },
          }),
  );
  vi.stubGlobal("fetch", fetchMock);
  new Function(shared)();
  new Function(widget)();
  document.querySelector<HTMLButtonElement>(".weletic-launcher-btn")!.click();
  await vi.waitFor(() =>
    expect(
      document.querySelector(
        sharing ? '[data-tab="refer"]' : ".weletic-guest-title",
      ),
    ).not.toBeNull(),
  );
  if (sharing)
    document.querySelector<HTMLButtonElement>('[data-tab="refer"]')!.click();
  return fetchMock;
}

function submit() {
  document.querySelector<HTMLInputElement>("#weletic-friend-email")!.value =
    "synthetic@example.test";
  document
    .querySelector<HTMLFormElement>("#weletic-friend-claim-form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

afterEach(() => {
  (window as any).WeleticLoyaltyWidgetRuntime?.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window as any).WeleticLoyaltyShared;
  delete (window as any).WeleticLoyaltyWidgetRuntime;
  window.sessionStorage.clear();
  document.body.innerHTML = "";
  document.documentElement.lang = "";
});

describe("referral claim interface locales with synthetic transport", () => {
  it.each([
    [
      "en",
      "Refer friends",
      "Sign in to get your personal referral link.",
      "Copy Referral Link",
      "Copied to Clipboard!",
      "Your referral link is not available yet.",
    ],
    [
      "ja",
      "友達を紹介する",
      "ログインして専用の紹介リンクを取得してください。",
      "紹介リンクをコピー",
      "コピーしました！",
      "紹介リンクはまだご利用いただけません。",
    ],
    [
      "vi",
      "Giới thiệu bạn bè",
      "Đăng nhập để nhận liên kết giới thiệu riêng của bạn.",
      "Sao chép liên kết giới thiệu",
      "Đã sao chép!",
      "Liên kết giới thiệu của bạn chưa khả dụng.",
    ],
  ])(
    "renders %s guest sharing instructions",
    async (locale, title, instruction) => {
      await mount(locale, "coupon", undefined, { guest: true });
      expect(document.body.textContent).toContain(title);
      expect(document.body.textContent).toContain(instruction);
      expect(document.querySelector("#weletic-copy-referral-btn")).toBeNull();
    },
  );

  it.each([
    [
      "en",
      "Copy Referral Link",
      "Copied to Clipboard!",
      "Your referral link is not available yet.",
    ],
    [
      "ja",
      "紹介リンクをコピー",
      "コピーしました！",
      "紹介リンクはまだご利用いただけません。",
    ],
    [
      "vi",
      "Sao chép liên kết giới thiệu",
      "Đã sao chép!",
      "Liên kết giới thiệu của bạn chưa khả dụng.",
    ],
  ])(
    "renders %s member sharing and escaped benefit names",
    async (locale, idle, copied) => {
      const writeText = vi.fn(async () => {});
      vi.spyOn(navigator, "clipboard", "get").mockReturnValue({
        writeText,
      } as unknown as Clipboard);
      const link = "https://fixture.myshopify.com/?ref=synthetic";
      await mount(locale, "coupon", undefined, { link });
      const button = document.querySelector<HTMLButtonElement>(
        "#weletic-copy-referral-btn",
      )!;
      expect(button.textContent).toBe(idle);
      expect(document.body.textContent).toContain("Merchant <b>reward</b>");
      expect(document.body.textContent).toContain("200 Coins");
      expect(document.querySelector(".weletic-drawer p b")).toBeNull();
      expect(document.body.innerHTML).not.toContain("PRIVATE_ACCOUNT");
      button.click();
      await vi.waitFor(() => expect(button.textContent).toBe(copied));
      expect(writeText).toHaveBeenCalledExactlyOnceWith(link);
    },
  );

  it.each([
    ["en", "Your referral link is not available yet."],
    ["ja", "紹介リンクはまだご利用いただけません。"],
    ["vi", "Liên kết giới thiệu của bạn chưa khả dụng."],
  ])(
    "renders %s missing-link state without a copy action",
    async (locale, message) => {
      await mount(locale, "coupon", undefined, { link: null });
      expect(document.body.textContent).toContain(message);
      expect(document.querySelector("#weletic-copy-referral-btn")).toBeNull();
    },
  );
  it.each([
    ["en", true, "We also emailed the code to you."],
    [
      "en",
      false,
      "Save this code now; email delivery is temporarily unavailable.",
    ],
    ["ja", true, "コードをメールでもお送りしました。"],
    [
      "ja",
      false,
      "メールを一時的に送信できないため、このコードを保存してください。",
    ],
    ["vi", true, "Chúng tôi cũng đã gửi mã qua email cho bạn."],
    [
      "vi",
      false,
      "Hãy lưu mã ngay; tính năng gửi email tạm thời không khả dụng.",
    ],
  ] as const)(
    "renders %s emailSent=%s truthfully",
    async (locale, emailSent, message) => {
      await mount(locale, "coupon", async () =>
        response({
          status: "claimed",
          discountCode: "SYNTHETIC-CODE",
          applyUrl: "/discount/SYNTHETIC-CODE",
          emailSent,
        }),
      );
      submit();
      await vi.waitFor(() =>
        expect(
          document.querySelector(".weletic-referral-note")?.textContent,
        ).toBe(message),
      );
    },
  );

  it.each(copy)(
    "renders %s points invitations without a coupon form",
    async (locale, invited) => {
      const fetchMock = await mount(locale, "points");
      expect(document.body.textContent).toContain(invited);
      expect(document.body.textContent).toContain("100 Coins");
      expect(document.querySelector("#weletic-friend-claim-form")).toBeNull();
      expect(
        fetchMock.mock.calls.some(([url]) => url.endsWith("/referral/claim")),
      ).toBe(false);
    },
  );

  it.each(copy)(
    "renders %s coupon copy, preserves escaped merchant names and shows claim success",
    async (locale, _invited, title, button, ready) => {
      const fetchMock = await mount(locale, "coupon", async () =>
        response({
          status: "claimed",
          discountCode: "SYNTHETIC-CODE",
          applyUrl: "/discount/SYNTHETIC-CODE",
          emailSent: false,
        }),
      );
      expect(document.body.textContent).toContain(title);
      expect(document.body.textContent).toContain("Merchant <b>reward</b>");
      expect(document.querySelector(".weletic-guest-desc b")).toBeNull();
      expect(
        document.querySelector("#weletic-friend-claim-form button")
          ?.textContent,
      ).toBe(button);
      submit();
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain(ready),
      );
      expect(document.querySelector(".weletic-wallet-code")?.textContent).toBe(
        "SYNTHETIC-CODE",
      );
      expect(
        fetchMock.mock.calls.filter(([url]) => url.endsWith("/referral/claim")),
      ).toHaveLength(1);
      expect(document.querySelector("#weletic-friend-email")).toBeNull();
    },
  );

  it.each(copy)(
    "renders %s eligibility review without inventing a coupon",
    async (locale, _invited, _title, _button, _ready, reviewed) => {
      await mount(locale, "coupon");
      submit();
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain(reviewed),
      );
      expect(document.querySelector(".weletic-wallet-code")).toBeNull();
    },
  );

  it.each(copy)(
    "localizes %s fallback claim errors",
    async (locale, _invited, _title, _button, _ready, _reviewed, failed) => {
      await mount(locale, "coupon", async () => response({}, 503));
      submit();
      await vi.waitFor(() =>
        expect(
          document.querySelector(".weletic-referral-error")?.textContent,
        ).toBe(failed),
      );
      expect(document.querySelector(".weletic-wallet-code")).toBeNull();
    },
  );
});
