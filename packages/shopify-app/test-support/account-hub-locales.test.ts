// @vitest-environment jsdom
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../extensions/weletic-customer-account/locales/en.default.json";
import ja from "../extensions/weletic-customer-account/locales/ja.json";
import viLocale from "../extensions/weletic-customer-account/locales/vi.json";
import {
  CustomerAccountLoyalty,
  customerReferralOfferCopy,
  CustomerRewardCard,
  customerRewardStatusDetail,
  customerRewardTerms,
  customerRewardTypeLabel,
  customerVipPeriodLabel,
  formatCustomerPoints,
  formatCustomerPointsExpiry,
  formatSavedCustomerBirthday,
  formatStoreCurrency,
  formatStoreMinorCurrency,
  RedeemRewardCard,
  validateIncrementalPointsSelection,
} from "../extensions/weletic-customer-account/src/CustomerAccountLoyalty";
import {
  hubActivityLabel,
  hubErrorText,
  hubRequestError,
} from "../extensions/weletic-customer-account/src/localization";

function host(locale: string) {
  const catalog = locale === "ja" ? ja : locale === "vi" ? viLocale : en;
  const formatNumber = vi.fn((value: number | bigint) =>
    new Intl.NumberFormat(locale).format(value),
  );
  vi.stubGlobal("shopify", {
    localization: { language: { value: { isoCode: locale } } },
    sessionToken: { get: vi.fn().mockResolvedValue("synthetic-hub-token") },
    i18n: {
      formatNumber,
      formatDate: (value: Date) =>
        new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(value),
      translate(key: string, values: Record<string, string | number> = {}) {
        const value =
          catalog.hub[key.replace(/^hub\./, "") as keyof typeof en.hub];
        if (!value) throw new Error(`Missing translation: ${key}`);
        return value.replace(/{{(\w+)}}/g, (_, name) => String(values[name]));
      },
    },
  });
  return { catalog, formatNumber };
}

afterEach(() => {
  act(() => render(null, document.body));
  vi.unstubAllGlobals();
});

describe("account hub redemption validation localization", () => {
  it.each(["en", "ja", "vi"])(
    "preserves non-JSON HTTP error guidance in %s",
    async (locale) => {
      const { catalog } = host(locale);
      for (const [status, key] of [
        [401, "errorAuthentication"],
        [403, "errorPermission"],
        [429, "errorRateLimit"],
      ] as const) {
        act(() => render(null, document.body));
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: false,
            status,
            json: async () => {
              throw new SyntaxError("private-response-detail");
            },
          }),
        );
        await act(async () =>
          render(h(CustomerAccountLoyalty, {}), document.body),
        );
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(document.body.textContent).toContain(catalog.hub[key]);
        expect(document.body.innerHTML).not.toContain(
          "private-response-detail",
        );
      }
    },
  );
  it.each(["en", "ja", "vi"])(
    "localizes every earning action without changing its link in %s",
    async (locale) => {
      const { catalog } = host(locale);
      const cases = [
        ["facebook_like", "openFacebook"],
        ["facebook_share", "shareFacebook"],
        ["instagram_follow", "openInstagram"],
        ["x_share", "shareX"],
        ["x_follow", "openX"],
        ["tiktok_follow", "openTikTok"],
        ["link_click", "openLink"],
        ["unknown_future_action", "openActivity"],
      ] as const;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            data: {
              isEnrolled: true,
              account: {
                status: "active",
                canParticipate: true,
                pointsBalance: "100",
                pendingPoints: "0",
              },
              program: { isActive: true },
              waysToEarn: cases.map(([triggerCode], index) => ({
                id: `private-rule-${index}`,
                name: `Merchant activity ${index}`,
                triggerCode,
                fixedPoints: "10",
                action: {
                  kind: "customer_intent",
                  url: `https://example.test/activity/${index}`,
                  label: "Server English action",
                  verification: "honor_system",
                },
              })),
            },
          }),
        }),
      );
      await act(async () =>
        render(h(CustomerAccountLoyalty, {}), document.body),
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      for (const [index, [, key]] of cases.entries()) {
        const button = document.querySelector(
          `s-button[href="https://example.test/activity/${index}"]`,
        );
        expect(button?.textContent).toBe(catalog.hub[key]);
        expect(button?.getAttribute("target")).toBe("_blank");
      }
      expect(document.body.innerHTML).not.toContain("Server English action");
      expect(document.body.innerHTML).not.toContain("private-rule-");
    },
  );
  it.each(["en", "ja", "vi"])(
    "formats exact decimal amounts and rejects invalid money in %s",
    (locale) => {
      const { catalog } = host(locale);
      for (const currency of ["JPY", "USD", "KWD"]) {
        const formatter = new Intl.NumberFormat(locale, {
          style: "currency",
          currency,
        });
        const digits = formatter.resolvedOptions().maximumFractionDigits!;
        const fraction = "123".slice(0, digits);
        const decimal = `900719925474099312${fraction ? `.${fraction}` : ""}`;
        const minor = BigInt(`900719925474099312${fraction}`);
        expect(formatStoreCurrency(decimal, currency)).toBe(
          formatStoreMinorCurrency(minor, currency),
        );
        expect(formatStoreCurrency(`-${decimal}`, currency)).toBe(
          formatStoreMinorCurrency(-minor, currency),
        );
        expect(formatStoreCurrency("0", currency)).toBe(formatter.format(0));
        expect(formatStoreCurrency("12.5", currency)).toBe(
          formatter.format(12.5),
        );
      }
      for (const [decimal, minor] of [
        ["1.005", 101n],
        ["-1.005", -101n],
        ["999.999", 100000n],
        ["1.004", 100n],
      ] as const) {
        expect(formatStoreCurrency(decimal, "USD")).toBe(
          formatStoreMinorCurrency(minor, "USD"),
        );
      }
      for (const invalid of [
        "",
        "NaN",
        "Infinity",
        "1e3",
        "1.2.3",
        "private-money",
        "1".repeat(129),
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        expect(formatStoreCurrency(invalid, "USD")).toBe(
          catalog.hub.amountUnavailable,
        );
      }
      for (const invalid of [
        "",
        "1.5",
        "private-money",
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        expect(formatStoreMinorCurrency(invalid, "USD")).toBe(
          catalog.hub.amountUnavailable,
        );
      }
      for (const invalidCurrency of ["", "not-a-currency", "US"]) {
        expect(formatStoreCurrency("1", invalidCurrency)).toBe(
          catalog.hub.amountUnavailable,
        );
        expect(formatStoreMinorCurrency("100", invalidCurrency)).toBe(
          catalog.hub.amountUnavailable,
        );
      }
    },
  );
  it.each(["en", "ja", "vi"])(
    "only claims the highest tier with complete tier evidence in %s",
    async (locale) => {
      const { catalog } = host(locale);
      const gold = {
        id: "private-gold",
        name: "Gold",
        slug: "gold",
        tierOrder: 2,
        minSpendThreshold: "100",
        minPointsThreshold: "100",
        pointsMultiplier: 1,
        entryBonusPoints: "0",
      };
      const higher = {
        ...gold,
        id: "private-platinum",
        name: "Platinum",
        tierOrder: 3,
      };
      for (const [tier, key] of [
        [undefined, "vipProgressUnavailable"],
        [null, "vipProgressUnavailable"],
        [{ currentTier: null, nextTier: null, allTiers: [] }, "vipUnavailable"],
        [
          { currentTier: gold, nextTier: null, allTiers: [gold] },
          "highestTier",
        ],
        [{ currentTier: gold, allTiers: [gold] }, "vipProgressUnavailable"],
        [{ currentTier: gold, nextTier: null }, "vipProgressUnavailable"],
        [
          { currentTier: gold, nextTier: null, allTiers: [gold, higher] },
          "vipProgressUnavailable",
        ],
        [
          { currentTier: gold, nextTier: null, allTiers: [higher] },
          "vipProgressUnavailable",
        ],
      ] as const) {
        act(() => render(null, document.body));
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
              data: {
                isEnrolled: true,
                account: {
                  status: "active",
                  canParticipate: true,
                  pointsBalance: "100",
                  pendingPoints: "0",
                },
                program: { isActive: true },
                tier,
              },
            }),
          }),
        );
        await act(async () =>
          render(h(CustomerAccountLoyalty, {}), document.body),
        );
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(document.body.textContent).toContain(catalog.hub[key]);
        if (key !== "highestTier")
          expect(document.body.textContent).not.toContain(
            catalog.hub.highestTier,
          );
        expect(document.body.innerHTML).not.toContain("private-gold");
        expect(document.body.innerHTML).not.toContain("private-platinum");
      }
    },
  );
  it.each(["en", "ja", "vi"])(
    "renders private authentication and activity retry states in %s",
    async (locale) => {
      const { catalog } = host(locale);
      const summary = {
        isEnrolled: true,
        account: {
          status: "active",
          canParticipate: true,
          pointsBalance: "100",
          pendingPoints: "0",
        },
        program: { isActive: true },
        recentActivity: Array.from({ length: 20 }, (_, index) => ({
          id: `private-ledger-${index}`,
          reason: "Referral reward for inviting friend (private-order-99)",
          entryType: "EARN_ORDER",
          pointsDelta: "1",
          createdAt: "2026-09-09T12:00:00Z",
        })),
      };
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: async () => ({ error: { message: "private-auth-detail" } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: summary }),
        })
        .mockRejectedValueOnce(new Error("private-transport-detail"))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: { activities: [], pagination: { hasMore: false } },
          }),
        });
      vi.stubGlobal("fetch", fetcher);
      const flush = async () => {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      };
      await act(async () =>
        render(h(CustomerAccountLoyalty, {}), document.body),
      );
      await flush();
      expect(document.body.textContent).toContain(
        catalog.hub.errorAuthentication,
      );
      expect(document.body.innerHTML).not.toContain("private-auth-detail");
      const click = async (label: string) => {
        const button = [...document.querySelectorAll("s-button")].find(
          (item) => item.textContent === label,
        )!;
        expect(button).toBeTruthy();
        await act(async () => {
          button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await flush();
      };
      await click(catalog.hub.retry);
      await click(catalog.hub.loadMore);
      expect(document.body.textContent).toContain(catalog.hub.errorActivity);
      expect(document.body.innerHTML).not.toContain("private-transport-detail");
      expect(document.body.innerHTML).not.toContain("private-ledger-");
      expect(document.body.innerHTML).not.toContain("private-order-99");
      expect(document.body.textContent).toContain(catalog.hub.ledgerOrder);
      await click(catalog.hub.loadMore);
      expect(fetcher.mock.calls[2][0]).toBe(fetcher.mock.calls[3][0]);
      expect(fetcher.mock.calls[3][0]).toContain("page=2");
      expect(document.body.textContent).not.toContain(
        catalog.hub.errorActivity,
      );
    },
  );
  it.each(["en", "ja", "vi"])(
    "maps errors without exposing remote details in %s",
    (locale) => {
      const { catalog } = host(locale);
      for (const [status, key] of [
        [401, "errorAuthentication"],
        [403, "errorPermission"],
        [429, "errorRateLimit"],
      ] as const) {
        for (const operation of [
          "summary",
          "activity",
          "redeem",
          "birthday",
          "earn",
        ] as const) {
          expect(
            hubRequestError(operation, status, "private-customer-99").message,
          ).toBe(catalog.hub[key]);
        }
      }
      expect(
        hubRequestError(
          "redeem",
          400,
          "Insufficient points balance: required 100, available -5.",
        ).message,
      ).toBe(catalog.hub.insufficientPoints);
      expect(
        hubRequestError(
          "redeem",
          400,
          "Reward is only available in Shopify POS.",
        ).message,
      ).toBe(catalog.hub.errorRewardUnavailable);
      expect(hubRequestError("birthday", 422).message).toBe(
        catalog.hub.errorBirthdayInvalid,
      );
      expect(
        hubRequestError(
          "birthday",
          409,
          "Birthday is already registered. Contact support to correct it.",
        ).message,
      ).toBe(catalog.hub.errorBirthdayLocked);
      for (const status of [400, 409, 500, undefined]) {
        expect(
          hubRequestError("redeem", status, "private-customer-99").message,
        ).toBe(catalog.hub.errorRedemptionUncertain);
      }
      expect(hubErrorText(new Error("private-customer-99"), "earn")).toBe(
        catalog.hub.errorEarningUncertain,
      );
    },
  );
  it.each(["en", "ja", "vi"])(
    "keeps uncertain redemption retries private and idempotent in %s",
    async (locale) => {
      const { catalog } = host(locale);
      const malformed = [
        null,
        {},
        [],
        "private-customer-99",
        { data: null },
        { data: {} },
        { artifactKind: "private-customer-99" },
        { artifactKind: null },
        {
          artifactKind: "discount_code",
          artifactCode: { private: "private-customer-99" },
        },
        { artifactKind: "store_credit", success: false },
        { discountCode: " " },
      ];
      let malformedIndex = 0;
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: {
              isEnrolled: true,
              account: {
                status: "active",
                canParticipate: true,
                pointsBalance: "100",
                pendingPoints: "0",
              },
              program: { isActive: true },
              rewards: [
                {
                  id: "synthetic-reward-definition",
                  name: "Merchant reward",
                  pointsCost: "100",
                  canRedeem: true,
                  salesChannel: "online_store",
                },
              ],
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 409,
          json: async () => ({
            error: {
              code: "customer_account_action_error",
              message: "private-customer-99",
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("private-customer-99");
          },
        })
        .mockImplementation(async () => ({
          ok: true,
          status: 200,
          json: async () => malformed[malformedIndex++ % malformed.length],
        }));
      vi.stubGlobal("fetch", fetcher);
      await act(async () =>
        render(h(CustomerAccountLoyalty, {}), document.body),
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      for (let attempt = 0; attempt < malformed.length + 3; attempt++) {
        const button = [...document.querySelectorAll("s-button")].find(
          (item) => item.textContent === catalog.hub.redeem,
        )!;
        expect(button).toBeTruthy();
        await act(async () => {
          button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(document.body.textContent).toContain(
          catalog.hub.errorRedemptionUncertain,
        );
        expect(document.body.innerHTML).not.toContain("private-customer-99");
      }
      expect(fetcher).toHaveBeenCalledTimes(malformed.length + 4);
      const first = JSON.parse(fetcher.mock.calls[1][1].body);
      const second = JSON.parse(fetcher.mock.calls[2][1].body);
      expect(first.idempotencyKey).toBeTruthy();
      expect(second).toEqual(first);
      for (const call of fetcher.mock.calls.slice(2)) {
        expect(JSON.parse(call[1].body)).toEqual(first);
      }
      expect(fetcher.mock.calls[1][1].headers.Authorization).toBe(
        "Bearer synthetic-hub-token",
      );
    },
  );
  it.each(["en", "ja", "vi"])(
    "uses the buyer locale for exact minor-unit currency in %s",
    (locale) => {
      host(locale);
      for (const currency of ["JPY", "USD", "KWD"]) {
        const formatter = new Intl.NumberFormat(locale, {
          style: "currency",
          currency,
        });
        const digits = formatter.resolvedOptions().maximumFractionDigits!;
        const scale = 10n ** BigInt(digits);
        for (const sign of [1n, -1n]) {
          // Intl accepts bigint whole units without rounding through Number.
          const whole = sign * 900719925474099312n;
          expect(formatStoreMinorCurrency(whole * scale, currency)).toBe(
            formatter.format(whole),
          );
          expect(formatStoreMinorCurrency(sign, currency)).toBe(
            formatter.format(Number(sign) / Number(scale)),
          );
        }
        expect(formatStoreMinorCurrency(scale, currency, "en-US")).toBe(
          new Intl.NumberFormat("en-US", {
            style: "currency",
            currency,
          }).format(1),
        );
      }
    },
  );
  it.each(["en", "ja", "vi"])(
    "keeps clipboard targets private and correctly paired in %s",
    (locale) => {
      host(locale);
      const codes = ["SYNTHETIC-CODE-A", "SYNTHETIC-CODE-B"];
      for (const order of [codes, [...codes].reverse()]) {
        act(() =>
          render(
            h(
              "div",
              {},
              order.map((code) =>
                h(CustomerRewardCard, {
                  key: code,
                  reward: {
                    id: "private-reward-customer-99",
                    status: "available",
                    rewardName: "Merchant voucher",
                    pointsSpent: "100",
                    issuedAt: "",
                    artifactCode: code,
                    applyUrl: `https://example.test/discount/${code}`,
                  },
                }),
              ),
            ),
            document.body,
          ),
        );
        const clipboards = [...document.querySelectorAll("s-clipboard-item")];
        expect(clipboards).toHaveLength(2);
        expect(new Set(clipboards.map((item) => item.id)).size).toBe(2);
        for (const [index, button] of [
          ...document.querySelectorAll('s-button[command="--copy"]'),
        ].entries()) {
          const targetId = button.getAttribute("commandfor")!;
          expect(targetId).toMatch(/^weletic-reward-[0-9a-f-]{36}$/);
          expect(document.getElementById(targetId)?.getAttribute("text")).toBe(
            order[index],
          );
        }
        expect(document.body.innerHTML).not.toContain(
          "private-reward-customer-99",
        );
      }
      act(() =>
        render(
          h(CustomerRewardCard, {
            actionsEnabled: false,
            reward: {
              id: "private-reward-customer-99",
              status: "available",
              rewardName: "Merchant voucher",
              pointsSpent: "100",
              issuedAt: "",
              artifactCode: codes[0],
            },
          }),
          document.body,
        ),
      );
      expect(document.querySelector("s-clipboard-item")).toBeNull();
      expect(document.querySelector('s-button[command="--copy"]')).toBeNull();
      expect(document.body.textContent).toContain(codes[0]);
      expect(document.body.innerHTML).not.toContain(
        "private-reward-customer-99",
      );
    },
  );
  it.each(["en", "ja", "vi"])(
    "renders exact earning confirmations in %s",
    async (locale) => {
      const { catalog } = host(locale);
      const activity = "<b>Merchant action</b>";
      for (const [result, expected] of [
        [
          { alreadyCompleted: true },
          catalog.hub.activityAlready.replace("{{activity}}", activity),
        ],
        [
          { pointsAwarded: "9007199254740993" },
          catalog.hub.activityAwarded
            .replace(
              "{{points}}",
              new Intl.NumberFormat(locale).format(BigInt("9007199254740993")),
            )
            .replace("{{activity}}", activity),
        ],
        [
          { pointsAwarded: "private-invalid-award" },
          catalog.hub.activityAwardUnavailable,
        ],
      ] as const) {
        act(() => render(null, document.body));
        const fetcher = vi
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              data: {
                isEnrolled: true,
                account: {
                  status: "active",
                  canParticipate: true,
                  pointsBalance: "0",
                  pendingPoints: "0",
                },
                program: { isActive: true },
                waysToEarn: [
                  {
                    id: "synthetic-rule",
                    name: activity,
                    triggerCode: "social_follow",
                    multiplier: 1,
                    fixedPoints: "100",
                    action: {
                      kind: "customer_intent",
                      url: "https://example.test/social",
                      label: "Merchant action button",
                      verification: "honor_system",
                    },
                  },
                ],
              },
            }),
          })
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ data: result }),
          })
          .mockRejectedValueOnce(new Error("synthetic-refresh-failure"));
        vi.stubGlobal("fetch", fetcher);
        await act(async () =>
          render(h(CustomerAccountLoyalty, {}), document.body),
        );
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        const button = [...document.querySelectorAll("s-button")].find(
          (item) => item.textContent === catalog.hub.openActivity,
        )!;
        await act(async () => {
          button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(
          document.querySelector('s-banner[tone="success"]')?.textContent,
        ).toBe(expected);
        expect(document.querySelector("b")).toBeNull();
        expect(document.body.innerHTML).not.toMatch(
          /private-invalid-award|synthetic-refresh-failure/,
        );
        expect(fetcher).toHaveBeenCalledTimes(3);
        expect(fetcher.mock.calls[1][0]).toBe(
          "https://shopify.weletic.com/api/customer-account/loyalty/customer/activity/claim",
        );
        expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
          ruleId: "synthetic-rule",
          claimKey: expect.any(String),
        });
      }
    },
  );
  it.each(["en", "ja", "vi"])(
    "maps all activity enums and rejects unknown values in %s",
    (locale) => {
      const { catalog } = host(locale);
      const mappings = {
        points: {
          EARN_ORDER: "ledgerOrder",
          EARN_REFERRAL: "ledgerReferral",
          EARN_BONUS: "ledgerBonus",
          REDEEM_REWARD: "ledgerRedeem",
          REFUND_REVERSAL: "ledgerRefund",
          MANUAL_ADJUSTMENT: "ledgerManual",
          EXPIRATION: "ledgerExpiry",
          BACKFILL: "ledgerImport",
          BACKFILL_CORRECTION: "ledgerCorrection",
          TIER_BONUS: "ledgerTier",
        },
        referrals: {
          pending: "refPending",
          qualified: "refQualified",
          rewarded: "refRewarded",
          cancelled: "refCancelled",
          fraud_blocked: "refBlocked",
        },
        vip: {
          threshold_reached: "tierThreshold",
          manual_override: "tierManual",
          annual_downgrade: "tierAnnual",
          bonus_promotion: "tierPromotion",
          grace_period_expired: "tierGrace",
          program_activation: "tierActivation",
        },
      } as const;
      for (const kind of ["points", "referrals", "vip"] as const) {
        for (const [value, key] of Object.entries(mappings[kind]))
          expect(hubActivityLabel(kind, value)).toBe(
            catalog.hub[key as keyof typeof catalog.hub],
          );
        for (const value of [
          undefined,
          null,
          "toString",
          "__proto__",
          "private-unknown",
        ])
          expect(hubActivityLabel(kind, value)).toBe(
            catalog.hub[
              kind === "points"
                ? "unknownPointsActivity"
                : kind === "referrals"
                  ? "unknownReferralActivity"
                  : "unknownVipActivity"
            ],
          );
      }
    },
  );
  it.each(["en", "ja", "vi"])(
    "renders localized activity history in %s",
    async (locale) => {
      const { catalog } = host(locale);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            data: {
              isEnrolled: true,
              account: {
                status: "active",
                canParticipate: true,
                pointsBalance: "10",
                pendingPoints: "0",
              },
              program: { isActive: true },
              recentActivity: [
                {
                  id: "private-ledger",
                  entryType: "EARN_ORDER",
                  pointsDelta: "10",
                  createdAt: "2026-09-09T12:00:00Z",
                },
              ],
              referral: {
                activity: [
                  {
                    id: "private-referral",
                    refereeName: "Friend",
                    status: "fraud_blocked",
                    advocatePointsAwarded: "0",
                    createdAt: "2026-09-09T12:00:00Z",
                  },
                ],
              },
              tier: {
                history: [
                  {
                    id: "private-tier-history",
                    fromTier: null,
                    toTier: null,
                    changeReason: "annual_downgrade",
                    effectiveAt: "2026-09-09T12:00:00Z",
                  },
                ],
              },
            },
          }),
        }),
      );
      await act(async () =>
        render(h(CustomerAccountLoyalty, {}), document.body),
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(document.body.textContent).toContain(catalog.hub.ledgerOrder);
      for (const [buttonText, expected] of [
        [catalog.hub.referrals, catalog.hub.refBlocked],
        ["VIP", catalog.hub.tierAnnual],
      ]) {
        const button = [...document.querySelectorAll("s-button")].find(
          (item) => item.textContent === buttonText,
        )!;
        act(() => {
          button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(document.body.textContent).toContain(expected);
      }
      expect(document.body.textContent).toContain(catalog.hub.noTier);
      expect(document.body.innerHTML).not.toMatch(
        /private-ledger|private-referral|private-tier-history/,
      );
    },
  );
  it.each(["en", "ja", "vi"])(
    "renders exact VIP and reward progress in %s",
    async (locale) => {
      const { catalog } = host(locale);
      for (const [value, key] of [
        ["rolling_12m", "periodRolling"],
        ["calendar_year", "periodCalendar"],
        ["lifetime", "periodLifetime"],
        ["private-unknown", "periodUnknown"],
        [undefined, "periodUnknown"],
      ] as const) {
        expect(customerVipPeriodLabel(value)).toBe(catalog.hub[key]);
      }
      const tier = {
        id: "private-tier",
        name: "Merchant Bronze",
        minPointsThreshold: "100",
        minSpendThreshold: "0",
        pointsMultiplier: 2,
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            data: {
              isEnrolled: true,
              account: {
                status: "active",
                canParticipate: true,
                pointsBalance: "100",
                pendingPoints: "0",
              },
              program: { isActive: true, vipTimeframe: "rolling_12m" },
              tier: {
                currentTier: tier,
                nextTier: { name: "<b>Gold</b>" },
                allTiers: [tier],
                progress: {
                  milestoneMode: "points_earned",
                  percent: 12.5,
                  spendRemaining: "0",
                  pointsRemaining: "9007199254740993",
                },
              },
              rewards: [
                {
                  id: "private-reward",
                  name: "Merchant voucher",
                  pointsCost: "200",
                  canRedeem: false,
                  salesChannel: "online_store",
                },
              ],
            },
          }),
        }),
      );
      await act(async () =>
        render(h(CustomerAccountLoyalty, {}), document.body),
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(document.body.textContent).toContain(
        catalog.hub.qualificationPeriod.replace(
          "{{period}}",
          catalog.hub.periodRolling,
        ),
      );
      expect(document.body.textContent).toContain(
        catalog.hub.pointsRequired.replace(
          "{{points}}",
          `100 ${catalog.hub.pointsName}`,
        ),
      );
      expect(document.body.textContent).toContain(
        catalog.hub.pointsToTier
          .replace(
            "{{points}}",
            `${new Intl.NumberFormat(locale).format(BigInt("9007199254740993"))} ${catalog.hub.pointsName}`,
          )
          .replace("{{tier}}", "<b>Gold</b>"),
      );
      expect(document.body.textContent).toContain(
        catalog.hub.pointsToReward
          .replace("{{points}}", `100 ${catalog.hub.pointsName}`)
          .replace("{{reward}}", "Merchant voucher"),
      );
      expect(document.body.textContent).toContain(
        catalog.hub.tierProgress
          .replace("{{percent}}", new Intl.NumberFormat(locale).format(12.5))
          .replace("{{tier}}", "<b>Gold</b>"),
      );
      expect(document.querySelector("b")).toBeNull();
      expect(document.body.innerHTML).not.toContain("private-tier");
    },
  );
  it.each(["en", "ja", "vi"])(
    "preserves issued confirmations after refresh failure in %s",
    async (locale) => {
      const { catalog } = host(locale);
      const code = "<img src=x onerror=alert(1)>";
      for (const [artifactKind, artifactCode, messageKey] of [
        ["store_credit", null, "issuedCredit"],
        ["gift_card", code, "issuedGiftCode"],
        ["gift_card", null, "issuedGiftWallet"],
        ["discount_code", code, "issuedDiscountCode"],
        ["discount_code", null, "issuedDiscountWallet"],
      ] as const) {
        act(() => render(null, document.body));
        const fetcher = vi
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              data: {
                isEnrolled: true,
                account: {
                  status: "active",
                  canParticipate: true,
                  pointsBalance: "100",
                  pendingPoints: "0",
                },
                program: { isActive: true },
                rewards: [
                  {
                    id: "synthetic-reward-definition",
                    name: "Merchant reward",
                    pointsCost: "100",
                    canRedeem: true,
                    salesChannel: "online_store",
                  },
                ],
              },
            }),
          })
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ data: { artifactKind, artifactCode } }),
          })
          .mockRejectedValueOnce(new Error("synthetic-refresh-error"));
        vi.stubGlobal("fetch", fetcher);
        await act(async () =>
          render(h(CustomerAccountLoyalty, {}), document.body),
        );
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        const redeem = [...document.querySelectorAll("s-button")].find(
          (button) => button.textContent === catalog.hub.redeem,
        )!;
        expect(redeem).toBeTruthy();
        await act(async () => {
          redeem.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(
          document.querySelector('s-banner[tone="success"]')?.textContent,
        ).toBe(catalog.hub[messageKey].replace("{{code}}", code));
        expect(document.body.textContent).not.toContain(
          "synthetic-refresh-error",
        );
        expect(document.querySelector("img")).toBeNull();
        expect(fetcher).toHaveBeenCalledTimes(3);
        const [url, init] = fetcher.mock.calls[1];
        expect(url).toBe(
          "https://shopify.weletic.com/api/customer-account/loyalty/customer/redeem",
        );
        expect(init.method).toBe("POST");
        expect(init.headers.Authorization).toBe("Bearer synthetic-hub-token");
        expect(JSON.parse(init.body)).toEqual({
          rewardDefinitionId: "synthetic-reward-definition",
          idempotencyKey: expect.any(String),
        });
      }
    },
  );
  it.each(["en", "ja", "vi"])(
    "keeps wallets visible while participation is unavailable in %s",
    async (locale) => {
      const { catalog } = host(locale);
      for (const [isActive, status, statusKey] of [
        [false, "active", "accountActive"],
        [true, "suspended", "accountSuspended"],
        [true, "closed", "accountClosed"],
        [true, "private-status-fixture", "accountUnavailable"],
      ] as const) {
        act(() => render(null, document.body));
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
              data: {
                isEnrolled: true,
                account: {
                  status,
                  canParticipate: true,
                  pointsBalance: "100",
                  pendingPoints: "0",
                },
                program: { isActive },
                shopper: { firstName: "<img src=x onerror=alert(1)>" },
                rewardWallet: [
                  {
                    id: "private-wallet-fixture",
                    status: "available",
                    rewardName: "Existing reward",
                    pointsSpent: "100",
                    issuedAt: "",
                    artifactKind: "store_credit",
                  },
                ],
                rewards: [
                  {
                    id: "private-definition",
                    name: "Hidden new reward",
                    pointsCost: "100",
                    canRedeem: true,
                    salesChannel: "online_store",
                  },
                ],
              },
            }),
          }),
        );
        await act(async () =>
          render(h(CustomerAccountLoyalty, {}), document.body),
        );
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(document.body.textContent).toContain(
          isActive
            ? catalog.hub.participationUnavailable.replace(
                "{{status}}",
                catalog.hub[statusKey],
              )
            : catalog.hub.paused,
        );
        expect(document.body.textContent).toContain("Existing reward");
        expect(document.body.textContent).not.toContain("Hidden new reward");
        expect(document.body.textContent).toContain(
          catalog.hub.welcomeNamed.replace(
            "{{name}}",
            "<img src=x onerror=alert(1)>",
          ),
        );
        expect(document.querySelector("img")).toBeNull();
        expect(document.body.innerHTML).not.toContain("private-status-fixture");
      }
    },
  );
  it.each(["en", "ja", "vi"])(
    "formats saved birthday without inventing dates in %s",
    (locale) => {
      const { catalog } = host(locale);
      for (const birthday of [
        {},
        { birthMonth: 13, birthDay: 1 },
        { birthMonth: 4, birthDay: 31 },
        { birthMonth: "2", birthDay: 2 },
        { birthMonth: 2, birthDay: 30 },
      ]) {
        expect(formatSavedCustomerBirthday(birthday)).toBe(
          catalog.hub.birthdayDetailsUnavailable,
        );
      }
      expect(
        formatSavedCustomerBirthday({
          birthMonth: 2,
          birthDay: 29,
          nextEligibleYear: 2028,
        }),
      ).toBe(
        catalog.hub.birthdaySaved
          .replace("{{month}}", "2")
          .replace("{{day}}", "29")
          .replace("{{year}}", "2028"),
      );
      expect(formatSavedCustomerBirthday({ birthMonth: 9, birthDay: 9 })).toBe(
        catalog.hub.birthdaySaved
          .replace("{{month}}", "9")
          .replace("{{day}}", "9")
          .replace("{{year}}", catalog.hub.yearUnavailable),
      );
    },
  );
  it.each(["en", "ja", "vi"])(
    "renders saved birthday and campaign copy in %s",
    async (locale) => {
      const { catalog } = host(locale);
      const birthday = {
        enabled: true,
        isRegistered: true,
        birthMonth: 9,
        birthDay: 9,
        nextEligibleYear: 2027,
      };
      const date = "2026-09-09T12:00:00Z";
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            data: {
              isEnrolled: true,
              account: {
                status: "active",
                canParticipate: true,
                pointsBalance: "0",
                pendingPoints: "0",
              },
              program: { isActive: true },
              birthday,
              activeCampaigns: [
                {
                  id: "private-campaign-one",
                  name: "Merchant bonus",
                  multiplier: 2.5,
                  endAt: date,
                  description: "<img src=x onerror=alert(1)>",
                },
                {
                  id: "private-campaign-two",
                  name: "Another bonus",
                  multiplier: 2,
                  endAt: "invalid",
                },
              ],
            },
          }),
        }),
      );
      await act(async () =>
        render(h(CustomerAccountLoyalty, {}), document.body),
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(document.body.textContent).toContain(
        formatSavedCustomerBirthday(birthday),
      );
      expect(document.querySelector("s-number-field")).toBeNull();
      expect(document.body.textContent).toContain(
        catalog.hub.campaignDescription
          .replace("{{multiplier}}", new Intl.NumberFormat(locale).format(2.5))
          .replace("{{name}}", "Merchant bonus")
          .replace("{{description}}", "<img src=x onerror=alert(1)>")
          .replace(
            "{{date}}",
            new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
              new Date(date),
            ),
          ),
      );
      expect(document.body.textContent).toContain(
        catalog.hub.campaignDetails
          .replace("{{multiplier}}", "2")
          .replace("{{name}}", "Another bonus")
          .replace("{{date}}", catalog.hub.dateUnavailable),
      );
      expect(document.querySelector("img")).toBeNull();
      expect(document.body.innerHTML).not.toMatch(
        /private-campaign|synthetic-hub-token/,
      );
    },
  );
  it.each(["en", "ja", "vi"])(
    "switches activity tabs and renders birthday entry in %s",
    async (locale) => {
      const { catalog } = host(locale);
      const fetcher = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            isEnrolled: true,
            account: {
              status: "active",
              canParticipate: true,
              pointsBalance: "0",
              pendingPoints: "0",
            },
            program: { isActive: true },
            birthday: { enabled: true, isRegistered: false },
          },
        }),
      });
      vi.stubGlobal("fetch", fetcher);
      await act(async () =>
        render(h(CustomerAccountLoyalty, {}), document.body),
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(document.body.textContent).toContain(catalog.hub.noPointsActivity);
      for (const [label, empty] of [
        [catalog.hub.referrals, catalog.hub.noReferralActivity],
        ["VIP", catalog.hub.noVipActivity],
        [catalog.hub.pointsName, catalog.hub.noPointsActivity],
      ]) {
        const button = [...document.querySelectorAll("s-button")].find(
          (item) => item.textContent === label,
        )!;
        expect(button).toBeTruthy();
        act(() => {
          button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(document.body.textContent).toContain(empty);
      }
      expect(document.body.textContent).toContain(catalog.hub.birthdayHelp);
      const fields = [...document.querySelectorAll("s-number-field")];
      expect(fields.map((field) => field.getAttribute("label"))).toEqual([
        catalog.hub.birthMonth,
        catalog.hub.birthDay,
      ]);
      expect(fields.map((field) => field.getAttribute("min"))).toEqual([
        "1",
        "1",
      ]);
      expect(fields.map((field) => field.getAttribute("max"))).toEqual([
        "12",
        "31",
      ]);
      expect(
        [...document.querySelectorAll("s-button")].some(
          (button) => button.textContent === catalog.hub.saveBirthday,
        ),
      ).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["en", "ja", "vi"])(
    "renders unknown expiry without fabricated details in %s",
    async (locale) => {
      const { catalog } = host(locale);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            data: {
              isEnrolled: true,
              account: {
                status: "active",
                canParticipate: true,
                pointsBalance: "0",
                pendingPoints: "0",
              },
              program: { isActive: true },
              pointsExpiry: { enabled: true },
            },
          }),
        }),
      );
      await act(async () =>
        render(h(CustomerAccountLoyalty, {}), document.body),
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(
        [...document.querySelectorAll("s-banner")].some(
          (banner) => banner.textContent === catalog.hub.expiryUnavailable,
        ),
      ).toBe(true);
      expect(document.body.textContent).not.toMatch(
        /undefined|NaN|Invalid Date/,
      );
    },
  );
  it.each(["en", "ja", "vi"])(
    "does not invent expiry details in %s",
    (locale) => {
      const { catalog } = host(locale);
      for (const policy of [
        {},
        { months: undefined },
        { months: null },
        { months: 0 },
        { months: -1 },
        { months: 1.5 },
        { months: "12" },
        { days: NaN },
        { days: Infinity },
        { days: 0, months: 0 },
        { days: "30", months: 12 },
        { nextExpiryDate: "invalid", days: 30 },
        { nextExpiryDate: 123 },
      ]) {
        expect(formatCustomerPointsExpiry(policy, "Merchant points")).toBe(
          catalog.hub.expiryUnavailable,
        );
      }
      expect(
        formatCustomerPointsExpiry(
          { days: 0, months: 12, nextExpiryDate: null },
          "Merchant points",
        ),
      ).toBe(
        catalog.hub.expiryMonths
          .replace("{{name}}", "Merchant points")
          .replace("{{months}}", "12"),
      );
      expect(
        formatCustomerPointsExpiry({ days: 30, months: 12 }, "Merchant points"),
      ).toBe(
        catalog.hub.expiryDays
          .replace("{{name}}", "Merchant points")
          .replace("{{days}}", "30"),
      );
      const date = "2026-09-09T12:00:00Z";
      expect(
        formatCustomerPointsExpiry(
          { nextExpiryDate: date, days: 30 },
          "Merchant points",
        ),
      ).toBe(
        catalog.hub.expiryOn
          .replace("{{name}}", "Merchant points")
          .replace(
            "{{date}}",
            new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
              new Date(date),
            ),
          ),
      );
    },
  );
  it.each(["en", "ja", "vi"])(
    "preserves referral timing and reward kinds in %s",
    (locale) => {
      const { catalog } = host(locale);
      for (const refereeRewardKind of ["points", "coupon"] as const) {
        for (const advocateRewardKind of ["points", "coupon"] as const) {
          const offer = {
            refereeRewardKind,
            advocateRewardKind,
            refereePointsReward: "100",
            advocatePointsReward: "200",
          };
          const result = customerReferralOfferCopy(offer);
          const friend =
            refereeRewardKind === "coupon"
              ? catalog.hub.couponReward
              : `100 ${catalog.hub.pointsName}`;
          const advocate =
            advocateRewardKind === "coupon"
              ? catalog.hub.couponReward
              : `200 ${catalog.hub.pointsName}`;
          const timing = catalog.hub[
            refereeRewardKind === "coupon" ? "referralBefore" : "referralAfter"
          ].replace("{{reward}}", friend);
          expect(result.heading).toBe(
            catalog.hub.referralHeading
              .replace("{{friend}}", friend)
              .replace("{{advocate}}", advocate),
          );
          expect(result.qualification).toBe(
            catalog.hub.referralQualification
              .replace("{{friendTiming}}", timing)
              .replace("{{reward}}", advocate),
          );
          expect(result.showPointsEarned).toBe(advocateRewardKind === "points");
        }
      }
    },
  );

  it.each(["en", "ja", "vi"])(
    "renders escaped referral copy and localized share messages in %s",
    async (locale) => {
      const { catalog } = host(locale);
      const program = "Merchant & program";
      const offer = {
        refereeRewardKind: "coupon" as const,
        advocateRewardKind: "points" as const,
        refereePointsReward: "0",
        advocatePointsReward: "200",
        refereeRewardName: "<img src=x onerror=alert(1)>",
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            data: {
              isEnrolled: true,
              account: {
                status: "active",
                canParticipate: true,
                pointsBalance: "0",
                pendingPoints: "100",
                lifetimePointsEarned: "200",
              },
              program: { isActive: true, name: program, currency: "JPY" },
              pointsExpiry: { enabled: true, days: 30 },
              tier: {
                currentTier: { name: "Merchant Gold", pointsMultiplier: 2 },
              },
              referral: {
                offer,
                qualifiedReferrals: 2,
                totalReferrals: 1234,
                totalPointsEarned: "9007199254740993",
                referralShareUrl: "https://example.test/invite?ref=synthetic",
              },
            },
          }),
        }),
      );
      await act(async () =>
        render(h(CustomerAccountLoyalty, {}), document.body),
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const copy = customerReferralOfferCopy(offer);
      expect(document.body.textContent).toContain(
        catalog.hub.pendingNamed.replace(
          "{{points}}",
          `100 ${catalog.hub.pointsName}`,
        ),
      );
      expect(document.body.textContent).toContain(
        catalog.hub.lifetimeNamed.replace(
          "{{points}}",
          `200 ${catalog.hub.pointsName}`,
        ),
      );
      expect(document.body.textContent).toContain(
        catalog.hub.expiryDays
          .replace("{{name}}", catalog.hub.pointsName)
          .replace("{{days}}", "30"),
      );
      expect(document.body.textContent).toContain(
        catalog.hub.earningRate.replace("{{multiplier}}", "2"),
      );
      expect(document.body.textContent).toContain(catalog.hub.noRewards);
      expect(document.body.textContent).toContain("Merchant Gold");
      expect(document.body.textContent).toContain(copy.heading);
      expect(document.body.textContent).toContain(copy.qualification);
      const stats = catalog.hub.referralStats
        .replace("{{qualified}}", "2")
        .replace("{{invited}}", new Intl.NumberFormat(locale).format(1234));
      expect(document.body.textContent).toContain(
        catalog.hub.referralStatsPoints
          .replace("{{stats}}", stats)
          .replace(
            "{{points}}",
            `${new Intl.NumberFormat(locale).format(BigInt("9007199254740993"))} ${catalog.hub.pointsName}`,
          ),
      );
      expect(
        [...document.querySelectorAll("s-section")].some(
          (section) =>
            section.getAttribute("heading") === catalog.hub.referFriend,
        ),
      ).toBe(true);
      expect(
        [...document.querySelectorAll("s-button")].some(
          (button) => button.textContent === catalog.hub.copyLink,
        ),
      ).toBe(true);
      expect(document.querySelector("img")).toBeNull();
      const email = [...document.querySelectorAll("s-button")].find((button) =>
        button.getAttribute("href")?.startsWith("mailto:"),
      );
      const query = new URLSearchParams(
        email!.getAttribute("href")!.slice("mailto:?".length),
      );
      expect(email?.textContent).toBe(catalog.hub.email);
      expect(query.get("subject")).toBe(
        catalog.hub.shareSubject.replace("{{program}}", program),
      );
      expect(query.get("body")).toBe(
        catalog.hub.shareMessage.replace("{{program}}", program) +
          "\n\nhttps://example.test/invite?ref=synthetic",
      );
    },
  );
  it.each(["en", "ja", "vi"])(
    "renders loading and enrollment screens in %s",
    async (locale) => {
      const { catalog } = host(locale);
      let resolveResponse!: (value: unknown) => void;
      vi.stubGlobal(
        "fetch",
        vi.fn(
          () =>
            new Promise((resolve) => {
              resolveResponse = resolve;
            }),
        ),
      );
      await act(async () =>
        render(h(CustomerAccountLoyalty, {}), document.body),
      );
      expect(document.querySelector("s-page")?.getAttribute("heading")).toBe(
        catalog.hub.hubTitle,
      );
      expect(document.querySelector("s-page")?.getAttribute("subheading")).toBe(
        catalog.hub.memberBenefits,
      );
      expect(
        document.querySelector("s-skeleton-paragraph")?.getAttribute("content"),
      ).toBe(catalog.hub.loadingPoints);
      resolveResponse({
        ok: true,
        json: async () => ({ data: { isEnrolled: false } }),
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(document.querySelector("s-banner")?.textContent).toBe(
        catalog.hub.joinNotice,
      );
      expect(document.body.innerHTML).not.toContain("synthetic-hub-token");
    },
  );

  it.each(["en", "ja", "vi"])(
    "renders unverifiable legacy terms in %s",
    (locale) => {
      const { catalog } = host(locale);
      for (const [termsSource, key] of [
        ["legacy", "legacyUnavailable"],
        ["unavailable", "termsUnverified"],
      ] as const) {
        act(() =>
          render(
            h(CustomerRewardCard, {
              reward: {
                id: "private-wallet-id",
                rewardName: "Merchant name",
                pointsSpent: "100",
                issuedAt: "",
                status: "expired",
                termsSource,
              },
            }),
            document.body,
          ),
        );
        expect(document.body.textContent).toContain(catalog.hub[key]);
      }
    },
  );
  it.each(["en", "ja", "vi"])(
    "preserves localized reward conditions in %s",
    (locale) => {
      const { catalog } = host(locale);
      const minimum = "9007199254740993";
      expect(
        customerRewardTerms(
          {
            salesChannel: "both",
            minOrderAmount: minimum,
            expiresInDays: 30,
            usageLimitPerCustomer: 2,
            entitlementCount: 1,
            combinesWithOrderDiscounts: true,
          },
          "JPY",
          locale,
        ),
      ).toEqual([
        catalog.hub.termsBoth,
        catalog.hub.termsMinimum.replace(
          "{{amount}}",
          new Intl.NumberFormat(locale, {
            style: "currency",
            currency: "JPY",
          }).format(BigInt(minimum)),
        ),
        catalog.hub.termsExpiry.replace("{{days}}", "30"),
        catalog.hub.termsUseMany.replace("{{uses}}", "2"),
        catalog.hub.termsSelected,
        catalog.hub.termsCombine,
      ]);
      expect(
        customerRewardTerms(
          {
            salesChannel: "pos",
            usageLimitPerCustomer: 1,
            appliesToResource: "entire_order",
          },
          "JPY",
          locale,
        ),
      ).toEqual([
        catalog.hub.termsPos,
        catalog.hub.termsUseOne.replace("{{uses}}", "1"),
        catalog.hub.termsEntire,
      ]);
      expect(
        customerRewardTerms({
          minOrderAmount: "0",
          expiresInDays: 0,
          usageLimitPerCustomer: 0,
        }),
      ).toEqual([]);
      expect(formatCustomerPoints("1")).toBe(
        catalog.hub.pointAmount.replace("{{points}}", "1"),
      );
      expect(formatCustomerPoints(minimum)).toBe(
        catalog.hub.pointsAmount.replace(
          "{{points}}",
          new Intl.NumberFormat(locale).format(BigInt(minimum)),
        ),
      );
      expect(formatCustomerPoints("1", "Merchant coin", "Merchant coins")).toBe(
        "1 Merchant coin",
      );
    },
  );
  it.each(["en", "ja", "vi"])(
    "localizes reward types and wallet states in %s",
    (locale) => {
      const { catalog } = host(locale);
      for (const [type, key] of [
        ["amount_off", "typeAmount"],
        ["percentage_off", "typePercentage"],
        ["free_shipping", "typeShipping"],
        ["free_product", "typeProduct"],
        ["gift_card", "typeGiftCard"],
        ["store_credit", "typeStoreCredit"],
        [undefined, "typeReward"],
      ] as const)
        expect(customerRewardTypeLabel(type)).toBe(catalog.hub[key]);
      const reward = {
        id: "wallet-fixture",
        rewardName: "Merchant name",
        pointsSpent: "100",
        issuedAt: "",
        status: "available" as const,
      };
      for (const [status, key] of [
        ["available", "statusAvailable"],
        ["used", "statusUsed"],
        ["expired", "statusExpired"],
        ["cancelled", "statusCancelled"],
      ] as const) {
        expect(customerRewardStatusDetail({ ...reward, status }, locale)).toBe(
          catalog.hub[key],
        );
        act(() =>
          render(
            h(CustomerRewardCard, { reward: { ...reward, status } }),
            document.body,
          ),
        );
        expect(document.querySelector("s-badge")?.textContent).toBe(
          catalog.hub[key],
        );
      }
      const date = "2026-09-09T12:00:00Z";
      const formatted = new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
      }).format(new Date(date));
      const expectedUsed = catalog.hub.usedOn.replace("{{date}}", formatted);
      expect(
        customerRewardStatusDetail({
          ...reward,
          status: "used",
          statusDate: date,
        }),
      ).toBe(expectedUsed);
      expect(
        customerRewardStatusDetail(
          { ...reward, status: "used", statusDate: date, orderName: "#100" },
          locale,
        ),
      ).toBe(
        catalog.hub.usedOrder
          .replace("{{status}}", expectedUsed)
          .replace("{{order}}", "#100"),
      );
      expect(
        customerRewardStatusDetail(
          { ...reward, status: "expired", statusDate: date },
          locale,
        ),
      ).toBe(catalog.hub.expiredOn.replace("{{date}}", formatted));
      expect(
        customerRewardStatusDetail(
          { ...reward, status: "cancelled", statusDate: date },
          locale,
        ),
      ).toBe(catalog.hub.cancelledOn.replace("{{date}}", formatted));
      expect(
        customerRewardStatusDetail({ ...reward, expiresAt: date }, locale),
      ).toBe(catalog.hub.expiresDate.replace("{{date}}", formatted));
      expect(
        customerRewardStatusDetail({ ...reward, issuedAt: date }, locale),
      ).toBe(
        catalog.hub.issuedDate
          .replace("{{status}}", catalog.hub.statusAvailable)
          .replace("{{date}}", formatted),
      );
    },
  );
  it.each(["en", "ja", "vi"])("uses exact native numbers in %s", (locale) => {
    const { catalog, formatNumber } = host(locale);
    const minimum = "9007199254740993";
    const result = validateIncrementalPointsSelection({
      pointsRequested: "1",
      pointsBalance: "9223372036854775807",
      pointsCost: minimum,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe(
      catalog.hub.minimumPoints.replace(
        "{{points}}",
        new Intl.NumberFormat(locale).format(BigInt(minimum)),
      ),
    );
    expect(formatNumber).toHaveBeenCalledWith(BigInt(minimum));
  });

  it.each(["en", "ja", "vi"])("covers every rejection in %s", (locale) => {
    const { catalog } = host(locale);
    const base = {
      pointsRequested: "100",
      pointsBalance: "500",
      pointsCost: "100",
    };
    for (const [input, key] of [
      [{ pointsCost: "bad" }, "limitsUnavailable"],
      [{ pointsRequested: "1.5" }, "wholePoints"],
      [{ pointsRequested: "600" }, "insufficientPoints"],
    ] as const) {
      expect(
        validateIncrementalPointsSelection({ ...base, ...input }).error,
      ).toBe(catalog.hub[key]);
    }
    expect(
      validateIncrementalPointsSelection({
        ...base,
        pointsRequested: "300",
        maxPointsCost: "200",
      }).error,
    ).toBe(catalog.hub.maximumPoints.replace("{{points}}", "200"));
    expect(
      validateIncrementalPointsSelection({ ...base, pointsRequested: "150" })
        .error,
    ).toBe(catalog.hub.pointsStep.replace("{{points}}", "100"));
    expect(validateIncrementalPointsSelection(base)).toEqual({
      valid: true,
      pointsRequested: "100",
      error: null,
    });
  });

  it.each(["en", "ja", "vi"])(
    "renders validation on the real card in %s",
    (locale) => {
      const { catalog } = host(locale);
      const onRedeem = vi.fn();
      act(() =>
        render(
          h(RedeemRewardCard, {
            reward: {
              id: "private-reward-fixture",
              name: "Merchant reward",
              pointsCost: "100",
              canRedeem: true,
              exchangeType: "incremental",
            },
            pointsBalance: "500",
            redeeming: null,
            selectedPoints: "5",
            onRedeem,
          }),
          document.body,
        ),
      );
      expect(
        document.querySelector("s-number-field")?.getAttribute("error"),
      ).toBe(catalog.hub.minimumPoints.replace("{{points}}", "100"));
      expect(document.querySelector("s-button")?.hasAttribute("disabled")).toBe(
        true,
      );
      expect(document.body.innerHTML).not.toContain("private-reward-fixture");
      expect(onRedeem).not.toHaveBeenCalled();
    },
  );

  it("keeps standalone English helper behavior", () => {
    expect(
      validateIncrementalPointsSelection({
        pointsRequested: "0",
        pointsBalance: "100",
        pointsCost: "100",
      }).error,
    ).toBe("Redeem at least 100 points.");
  });
});
