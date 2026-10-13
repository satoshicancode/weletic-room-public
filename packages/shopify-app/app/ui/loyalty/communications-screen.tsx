import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  InlineStack,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import {
  loyaltyCommunicationJourneySchema,
  loyaltyCommunicationPolicySchema,
  loyaltyCommunicationVariables,
  renderLoyaltyCommunicationText,
  verifyLoyaltyCommunicationsResponse,
  type LoyaltyCommunicationJourney,
  type LoyaltyCommunicationsRequest,
  type LoyaltyCommunicationsResponse,
} from "@weletic/contracts/loyalty/communications-contract";
import React, { useRef, useState } from "react";
import { communicationsCopy } from "./communications-copy";
import { createDefaultLoyaltyCommunicationPolicy } from "./communications-defaults";

type Locale = keyof typeof communicationsCopy;
type Policy = ReturnType<typeof createDefaultLoyaltyCommunicationPolicy>;
export type CommunicationsTransport = (
  request: LoyaltyCommunicationsRequest,
) => Promise<LoyaltyCommunicationsResponse>;
export function CommunicationsScreen({
  request,
  onNavigationStateChange,
}: {
  request: CommunicationsTransport;
  onNavigationStateChange?: (state: { dirty: boolean; locale: Locale }) => void;
}) {
  const shopify = useAppBridge();
  const [locale, setLocale] = useState<Locale>("en");
  const [contentLocale, setContentLocale] = useState<Locale>("en");
  const [journey, setJourney] =
    useState<LoyaltyCommunicationJourney>("points_earned");
  const [state, setState] = useState<LoyaltyCommunicationsResponse | null>(
    null,
  );
  const [draft, setDraft] = useState<Policy | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<"error" | "invalid" | "saved" | null>(
    null,
  );
  const [mobile, setMobile] = useState(true);
  const epoch = useRef(0);
  const copy = communicationsCopy[locale];
  const rewardExpiryIntegration =
    state?.deliveryIntegration ===
    "purchase_signup_birthday_vip_redemption_reward_expiry_and_expiry_policies";
  const redemptionIntegration =
    rewardExpiryIntegration ||
    state?.deliveryIntegration ===
      "purchase_signup_birthday_vip_redemption_and_expiry_policies";
  const vipIntegration =
    redemptionIntegration ||
    state?.deliveryIntegration ===
      "purchase_signup_birthday_vip_and_expiry_policies";
  const birthdayIntegration =
    vipIntegration ||
    state?.deliveryIntegration ===
      "purchase_signup_birthday_and_expiry_policies";
  const birthdayConnected = birthdayIntegration && journey === "birthday";
  const signupConnected =
    (birthdayIntegration ||
      state?.deliveryIntegration === "purchase_signup_and_expiry_policies") &&
    journey === "points_earned";
  const purchaseConnected =
    state?.deliveryIntegration === "purchase_and_expiry_policies" &&
    journey === "points_earned";
  const expiryConnected =
    (birthdayIntegration ||
      state?.deliveryIntegration === "expiry_policies" ||
      state?.deliveryIntegration === "purchase_and_expiry_policies" ||
      state?.deliveryIntegration === "purchase_signup_and_expiry_policies") &&
    (journey === "points_warning" || journey === "points_last_chance");
  const connectedCopy =
    rewardExpiryIntegration && journey === "reward_expiry"
      ? {
          description: copy.rewardExpiryConnected,
          saved: copy.rewardExpirySaved,
          enabled: copy.rewardExpiryEnabled,
        }
      : redemptionIntegration && journey === "reward_redeemed"
        ? {
            description: copy.redemptionConnected,
            saved: copy.redemptionSaved,
            enabled: copy.redemptionEnabled,
          }
        : vipIntegration && journey === "vip_achieved"
          ? {
              description: copy.vipConnected,
              saved: copy.vipSaved,
              enabled: copy.vipEnabled,
            }
          : birthdayConnected
            ? {
                description: copy.birthdayConnected,
                saved: copy.birthdaySaved,
                enabled: copy.birthdayEnabled,
              }
            : signupConnected
              ? {
                  description: birthdayIntegration
                    ? copy.signupWithBirthdayConnected
                    : copy.signupConnected,
                  saved: copy.signupSaved,
                  enabled: copy.signupEnabled,
                }
              : purchaseConnected
                ? {
                    description: copy.purchaseConnected,
                    saved: copy.purchaseSaved,
                    enabled: copy.purchaseEnabled,
                  }
                : expiryConnected
                  ? {
                      description: copy.expiryConnected,
                      saved: copy.expirySaved,
                      enabled: copy.expiryEnabled,
                    }
                  : null;
  React.useEffect(() => {
    onNavigationStateChange?.({ dirty, locale });
  }, [dirty, locale, onNavigationStateChange]);
  function draftFor(
    result: LoyaltyCommunicationsResponse,
    selected: LoyaltyCommunicationJourney,
  ) {
    return (
      result.policies.find((policy) => policy.journey === selected) ??
      createDefaultLoyaltyCommunicationPolicy(selected)
    );
  }
  React.useEffect(() => {
    const fence = epoch;
    const version = ++fence.current;
    setState(null);
    setDraft(null);
    setDirty(false);
    setMessage(null);
    setBusy(true);
    setJourney("points_earned");
    const input = { operation: "read" } as const;
    request(input)
      .then((value) => {
        if (version !== fence.current) return;
        const result = verifyLoyaltyCommunicationsResponse(input, value);
        setState(result);
        setDraft(draftFor(result, "points_earned"));
      })
      .catch(() => {
        if (version === fence.current) setMessage("error");
      })
      .finally(() => {
        if (version === fence.current) setBusy(false);
      });
    return () => {
      fence.current++;
    };
  }, [request]);

  async function reload() {
    const version = ++epoch.current;
    setBusy(true);
    setState(null);
    setDraft(null);
    setDirty(false);
    setMessage(null);
    const input = { operation: "read" } as const;
    try {
      const result = verifyLoyaltyCommunicationsResponse(
        input,
        await request(input),
      );
      if (version !== epoch.current) return;
      setState(result);
      setDraft(draftFor(result, journey));
    } catch {
      if (version === epoch.current) setMessage("error");
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  }
  async function save() {
    if (!state?.capabilities.configure || !draft || busy) return;
    const parsed = loyaltyCommunicationPolicySchema.safeParse(draft);
    if (!parsed.success) {
      setMessage("invalid");
      shopify.toast?.show?.(copy.invalid, { isError: true });
      return;
    }
    const input = {
      operation: "save",
      expectedInstallationGeneration: state.installationGeneration,
      expectedRevision: state.revision,
      policy: parsed.data,
    } as const;
    const version = ++epoch.current;
    setBusy(true);
    setMessage(null);
    try {
      const result = verifyLoyaltyCommunicationsResponse(
        input,
        await request(input),
      );
      if (version !== epoch.current) return;
      setState(result);
      setDraft(draftFor(result, journey));
      setDirty(false);
      setMessage("saved");
      shopify.toast?.show?.(connectedCopy?.saved ?? copy.saved);
    } catch {
      if (version === epoch.current) {
        setState(null);
        setMessage("error");
        shopify.toast?.show?.(copy.error, { isError: true });
      }
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  }
  function change(field: keyof Policy["templates"]["en"], value: string) {
    if (!draft) return;
    setDraft({
      ...draft,
      templates: {
        ...draft.templates,
        [contentLocale]: { ...draft.templates[contentLocale], [field]: value },
      },
    });
    setDirty(true);
    setMessage(null);
  }
  const valid =
    draft && loyaltyCommunicationPolicySchema.safeParse(draft).success;
  const sampleValues = Object.fromEntries(
    loyaltyCommunicationVariables[journey].map((name) => [name, `[${name}]`]),
  );
  const preview =
    valid && draft
      ? Object.fromEntries(
          Object.entries(draft.templates[contentLocale]).map(
            ([field, text]) => [
              field,
              renderLoyaltyCommunicationText(text, journey, sampleValues),
            ],
          ),
        )
      : null;
  const disabled = busy || !state?.capabilities.configure;
  const languageSelectOptions = [
    { label: "English", value: "en" },
    { label: "日本語", value: "ja" },
    { label: "Tiếng Việt", value: "vi" },
  ];
  const journeyOptions = loyaltyCommunicationJourneySchema.options.map(
    (item) => ({
      label:
        createDefaultLoyaltyCommunicationPolicy(item).templates[locale].heading,
      value: item,
    }),
  );

  return (
    <article className="weletic-communications" lang={locale} aria-busy={busy}>
      <BlockStack gap="400">
        <Text as="h1" variant="headingLg">
          {copy.title}
        </Text>
        <Select
          label={copy.language}
          options={languageSelectOptions}
          value={locale}
          onChange={(val) => setLocale(val as Locale)}
        />
        <Text as="p" tone="subdued">
          {connectedCopy?.description ?? copy.disconnected}
        </Text>
        {busy && <p role="status">{copy.loading}</p>}
        {message && (
          <Banner
            tone={message === "saved" ? "success" : "critical"}
            onDismiss={() => setMessage(null)}
          >
            <p role={message === "saved" ? "status" : "alert"}>
              {message === "saved" && connectedCopy
                ? connectedCopy.saved
                : copy[message]}
            </p>
          </Banner>
        )}
        {state && !state.capabilities.configure && (
          <Banner tone="info">
            <p>{copy.readonly}</p>
          </Banner>
        )}
        <InlineStack gap="300">
          <Button disabled={busy} onClick={() => void reload()}>
            {copy.reload}
          </Button>
        </InlineStack>
        {draft && (
          <Card>
            <BlockStack gap="400">
              <Select
                label={copy.journey}
                disabled={busy || dirty || !state}
                options={journeyOptions}
                value={journey}
                onChange={(val) => {
                  const selected = loyaltyCommunicationJourneySchema.parse(val);
                  setJourney(selected);
                  setDraft(draftFor(state!, selected));
                  setMessage(null);
                }}
              />
              {dirty && (
                <Text as="p" tone="caution">
                  {copy.dirty}
                </Text>
              )}
              <Select
                label={copy.contentLanguage}
                disabled={busy}
                options={languageSelectOptions}
                value={contentLocale}
                onChange={(val) => setContentLocale(val as Locale)}
              />
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                <BlockStack gap="400">
                  <Text as="h3" variant="headingSm">
                    {copy.title}
                  </Text>
                  <Checkbox
                    disabled={disabled}
                    label={connectedCopy?.enabled ?? copy.enabled}
                    checked={draft.enabled}
                    onChange={(checked) => {
                      setDraft({ ...draft, enabled: checked });
                      setDirty(true);
                      setMessage(null);
                    }}
                  />
                  {(["subject", "heading", "body", "actionLabel"] as const).map(
                    (field) => (
                      <TextField
                        key={field}
                        disabled={disabled}
                        label={copy[field]}
                        autoComplete="off"
                        multiline={field === "body" ? 6 : undefined}
                        maxLength={
                          field === "body"
                            ? 5000
                            : field === "actionLabel"
                              ? 80
                              : 200
                        }
                        value={draft.templates[contentLocale][field]}
                        onChange={(val) => change(field, val)}
                      />
                    ),
                  )}
                  <InlineStack gap="300">
                    <Button
                      submit
                      variant="primary"
                      disabled={disabled || !dirty}
                    >
                      {copy.save}
                    </Button>
                    <Button
                      disabled={busy || !state || !dirty}
                      onClick={() => {
                        setDraft(draftFor(state!, journey));
                        setDirty(false);
                        setMessage(null);
                      }}
                    >
                      {copy.discard}
                    </Button>
                  </InlineStack>
                </BlockStack>
              </form>
              <Text as="p" tone="subdued">
                {copy.variables}:{" "}
                {loyaltyCommunicationVariables[journey]
                  .map((name) => `{{${name}}}`)
                  .join(", ")}
              </Text>
              <Checkbox
                label={mobile ? copy.mobile : copy.desktop}
                checked={mobile}
                onChange={(checked) => setMobile(checked)}
              />
              <section
                aria-label={copy.preview}
                style={{ maxWidth: mobile ? 375 : 640 }}
              >
                <Card>
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">
                      {copy.preview}
                    </Text>
                    {preview ? (
                      <div lang={contentLocale}>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {preview.subject}
                        </Text>
                        <Text as="h4" variant="headingMd">
                          {preview.heading}
                        </Text>
                        <p style={{ whiteSpace: "pre-wrap" }}>{preview.body}</p>
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          {preview.actionLabel}
                        </Text>
                      </div>
                    ) : (
                      <Text as="p" tone="critical">
                        {copy.invalid}
                      </Text>
                    )}
                  </BlockStack>
                </Card>
              </section>
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </article>
  );
}
