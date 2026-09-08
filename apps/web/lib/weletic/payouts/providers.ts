export const WELETIC_PAYOUT_PROVIDERS = {
  stripe_connect: {
    methods: ["bank", "wallet"],
    requiresConnectedAccount: true,
    automaticSettlement: true,
    supportedPayoutCurrencies: ["USD"],
  },
  paypal: {
    methods: ["paypal"],
    requiresConnectedAccount: true,
    automaticSettlement: true,
    supportedPayoutCurrencies: [
      "AUD",
      "BRL",
      "CAD",
      "CNY",
      "CZK",
      "DKK",
      "EUR",
      "HKD",
      "HUF",
      "ILS",
      "JPY",
      "MYR",
      "MXN",
      "TWD",
      "NZD",
      "NOK",
      "PHP",
      "PLN",
      "GBP",
      "SGD",
      "SEK",
      "CHF",
      "THB",
      "USD",
    ],
  },
  bank_transfer: {
    methods: ["bank"],
    requiresConnectedAccount: false,
    automaticSettlement: false,
    supportedPayoutCurrencies: null,
  },
  manual: {
    methods: ["manual"],
    requiresConnectedAccount: false,
    automaticSettlement: false,
    supportedPayoutCurrencies: null,
  },
} as const;

export type WeleticPayoutProvider = keyof typeof WELETIC_PAYOUT_PROVIDERS;
export type WeleticPayoutMethod =
  (typeof WELETIC_PAYOUT_PROVIDERS)[WeleticPayoutProvider]["methods"][number];

export function assertPayoutProviderCompatibility({
  provider,
  method,
  providerAccountRef,
  payoutCurrency,
  requireConnectedAccount = true,
}: {
  provider: WeleticPayoutProvider;
  method: WeleticPayoutMethod;
  providerAccountRef?: string | null;
  payoutCurrency?: string | null;
  requireConnectedAccount?: boolean;
}) {
  const configuration = WELETIC_PAYOUT_PROVIDERS[provider];
  if (!(configuration.methods as readonly string[]).includes(method)) {
    throw new Error(`${method} is not supported by ${provider}.`);
  }
  if (
    payoutCurrency &&
    configuration.supportedPayoutCurrencies &&
    !(configuration.supportedPayoutCurrencies as readonly string[]).includes(
      payoutCurrency.toUpperCase(),
    )
  ) {
    throw new Error(
      `${provider} does not support ${payoutCurrency.toUpperCase()} settlement.`,
    );
  }
  if (
    requireConnectedAccount &&
    configuration.requiresConnectedAccount &&
    !providerAccountRef
  ) {
    throw new Error(
      `${provider} must be connected before the payout profile can be verified.`,
    );
  }
  return configuration;
}
