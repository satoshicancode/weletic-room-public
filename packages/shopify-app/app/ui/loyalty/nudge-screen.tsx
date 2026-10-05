import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  InlineGrid,
  InlineStack,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import {
  defaultLoyaltyNudgeSettings,
  loyaltyNudgeKinds,
  loyaltyNudgeSettingsSchema,
  verifyLoyaltyNudgeResponse,
  type LoyaltyNudgeKind,
  type LoyaltyNudgeRequest,
  type LoyaltyNudgeResponse,
  type LoyaltyNudgeSettings,
} from "@weletic/contracts/loyalty/nudge-contract";
import { nudgeCopy } from "./nudge-copy";

type Locale = keyof typeof nudgeCopy;
type Policy = LoyaltyNudgeSettings["policies"][number];

export function LoyaltyNudgeScreen({
  request,
  onNavigationStateChange,
}: {
  request: (input: LoyaltyNudgeRequest) => Promise<LoyaltyNudgeResponse>;
  onNavigationStateChange?: (state: { dirty: boolean; locale: Locale }) => void;
}) {
  const shopify = useAppBridge();
  const [locale, setLocale] = useState<Locale>("en");
  const [contentLocale, setContentLocale] = useState<Locale>("en");
  const [kind, setKind] = useState<LoyaltyNudgeKind>("signup");
  const [state, setState] = useState<LoyaltyNudgeResponse | null>(null);
  const [draft, setDraft] = useState<LoyaltyNudgeSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<"saved" | "invalid" | "error" | null>(
    null,
  );
  const epoch = useRef(0);
  const saving = React.useRef(false);
  const copy = nudgeCopy[locale];

  useEffect(
    () => onNavigationStateChange?.({ dirty, locale }),
    [dirty, locale, onNavigationStateChange],
  );

  const reload = useCallback(async () => {
    const version = ++epoch.current;
    saving.current = false;
    setBusy(true);
    setState(null);
    setDraft(null);
    setDirty(false);
    setMessage(null);
    const input = { operation: "read" } as const;
    try {
      const result = verifyLoyaltyNudgeResponse(input, await request(input));
      if (version !== epoch.current) return;
      setState(result);
      setDraft(result.settings);
    } catch {
      if (version === epoch.current) setMessage("error");
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  }, [request]);

  useEffect(() => {
    const requestEpoch = epoch;
    void reload();
    return () => {
      requestEpoch.current++;
    };
  }, [reload]);

  const disabled =
    busy || !state?.capabilities.configure || !state.programConfigured;
  const policy = draft?.policies.find((p) => p.kind === kind);
  const validation = loyaltyNudgeSettingsSchema.safeParse(draft);
  const valid = draft !== null && validation.success;

  function change(next: Policy) {
    if (!draft || disabled) return;
    setDraft({
      ...draft,
      policies: draft.policies.map((p) => (p.kind === kind ? next : p)),
    });
    setDirty(true);
    setMessage(null);
  }

  async function save() {
    if (saving.current || disabled || !state || !draft || !dirty) return;
    const parsed = loyaltyNudgeSettingsSchema.safeParse(draft);
    if (!parsed.success) {
      setMessage("invalid");
      shopify.toast?.show?.(copy.invalid, { isError: true });
      return;
    }
    const input = {
      operation: "save",
      expectedInstallationGeneration: state.installationGeneration,
      expectedRevision: state.revision,
      settings: parsed.data,
    } as const;
    const storeId = state.storeId;
    const version = ++epoch.current;
    saving.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = verifyLoyaltyNudgeResponse(input, await request(input));
      if (version !== epoch.current) return;
      if (result.storeId !== storeId) throw new Error("Nudge scope changed");
      setState(result);
      setDraft(result.settings);
      setDirty(false);
      setMessage("saved");
      shopify.toast?.show?.(copy.saved);
    } catch {
      if (version === epoch.current) {
        setState(null);
        setMessage("error");
        shopify.toast?.show?.(copy.error, { isError: true });
      }
    } finally {
      if (version === epoch.current) {
        saving.current = false;
        setBusy(false);
      }
    }
  }

  const languageOptions = [
    { label: "English", value: "en" },
    { label: "日本語", value: "ja" },
    { label: "Tiếng Việt", value: "vi" },
  ];

  const kindOptions = loyaltyNudgeKinds.map((k) => ({
    label: copy[k],
    value: k,
  }));

  const iconOptions = (["gift", "star", "award", "sparkles"] as const).map(
    (icon) => ({
      label: copy[icon],
      value: icon,
    }),
  );

  return (
    <Page
      title={copy.title}
      primaryAction={{
        content: copy.save,
        onAction: () => void save(),
        disabled: !valid || !dirty || busy,
      }}
      secondaryActions={[
        {
          content: copy.reload,
          onAction: () => void reload(),
          disabled: busy,
        },
      ]}
    >
      <BlockStack gap="400">
        <InlineStack align="end">
          <Select
            label={copy.language}
            labelInline
            value={locale}
            options={languageOptions}
            onChange={(val) => setLocale(val as Locale)}
          />
        </InlineStack>

        <Card>
          <Text as="p" variant="bodySm" tone="subdued">
            {copy.note}
          </Text>
        </Card>

        {busy && (
          <Card>
            <Text as="p" tone="subdued">
              {copy.loading}
            </Text>
          </Card>
        )}

        {message && (
          <Banner tone={message === "saved" ? "success" : "critical"}>
            <p>{copy[message]}</p>
          </Banner>
        )}

        {dirty && !validation.success && (
          <Banner tone="critical">
            <BlockStack gap="200">
              <p>{copy.invalid}</p>
              <ul>
                {validation.error.issues.map((issue, index) => {
                  const invalidKind =
                    draft?.policies[Number(issue.path[1])]?.kind;
                  const invalidLocale = issue.path[3];
                  const field = issue.path[4];
                  return (
                    <li key={index}>
                      {invalidKind ? copy[invalidKind] : copy.title}
                      {typeof invalidLocale === "string"
                        ? ` · ${invalidLocale.toUpperCase()}`
                        : ""}
                      {field === "title"
                        ? ` · ${copy.subject}`
                        : field === "description"
                          ? ` · ${copy.description}`
                          : field === "actionLabel"
                            ? ` · ${copy.actionLabel}`
                            : ""}
                    </li>
                  );
                })}
              </ul>
            </BlockStack>
          </Banner>
        )}

        {state && !state.capabilities.configure && (
          <Card>
            <Text as="p" tone="subdued">
              {copy.readonly}
            </Text>
          </Card>
        )}
        {state && !state.programConfigured && (
          <Banner tone="warning">
            <p>{copy.missing}</p>
          </Banner>
        )}

        {policy && (
          <>
            <Card>
              <BlockStack gap="400">
                <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
                  <Select
                    label={copy.kind}
                    value={kind}
                    disabled={busy}
                    options={kindOptions}
                    onChange={(val) => setKind(val as LoyaltyNudgeKind)}
                  />
                  <Select
                    label={copy.contentLanguage}
                    value={contentLocale}
                    disabled={busy}
                    options={languageOptions}
                    onChange={(val) => setContentLocale(val as Locale)}
                  />
                </InlineGrid>

                <Checkbox
                  label={copy.enabled}
                  name="enabled"
                  checked={policy.enabled}
                  disabled={disabled}
                  onChange={(checked) =>
                    change({ ...policy, enabled: checked })
                  }
                />

                <Select
                  label={copy.icon}
                  name="icon"
                  value={policy.icon}
                  disabled={disabled}
                  options={iconOptions}
                  onChange={(val) =>
                    change({ ...policy, icon: val as Policy["icon"] })
                  }
                />

                <TextField
                  label={copy.subject}
                  name="title"
                  value={policy.templates[contentLocale].title}
                  maxLength={100}
                  disabled={disabled}
                  autoComplete="off"
                  onChange={(val) =>
                    change({
                      ...policy,
                      templates: {
                        ...policy.templates,
                        [contentLocale]: {
                          ...policy.templates[contentLocale],
                          title: val,
                        },
                      },
                    })
                  }
                />

                <TextField
                  label={copy.description}
                  name="description"
                  multiline={3}
                  value={policy.templates[contentLocale].description}
                  maxLength={300}
                  disabled={disabled}
                  autoComplete="off"
                  onChange={(val) =>
                    change({
                      ...policy,
                      templates: {
                        ...policy.templates,
                        [contentLocale]: {
                          ...policy.templates[contentLocale],
                          description: val,
                        },
                      },
                    })
                  }
                />

                <TextField
                  label={copy.actionLabel}
                  name="actionLabel"
                  value={policy.templates[contentLocale].actionLabel}
                  maxLength={60}
                  disabled={disabled}
                  autoComplete="off"
                  onChange={(val) =>
                    change({
                      ...policy,
                      templates: {
                        ...policy.templates,
                        [contentLocale]: {
                          ...policy.templates[contentLocale],
                          actionLabel: val,
                        },
                      },
                    })
                  }
                />

                <InlineStack align="space-between">
                  <Button
                    variant="plain"
                    disabled={disabled}
                    onClick={() =>
                      change({
                        ...policy,
                        templates: defaultLoyaltyNudgeSettings().policies.find(
                          (p) => p.kind === kind,
                        )!.templates,
                      })
                    }
                  >
                    {copy.restore}
                  </Button>
                  <InlineStack gap="200">
                    <Button
                      disabled={disabled || !dirty}
                      onClick={() => {
                        setDraft(state!.settings);
                        setDirty(false);
                        setMessage(null);
                      }}
                    >
                      {copy.discard}
                    </Button>
                    <Button
                      variant="primary"
                      disabled={!valid || !dirty || busy}
                      onClick={() => void save()}
                    >
                      {copy.save}
                    </Button>
                  </InlineStack>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  {copy.preview}
                </Text>
                <Box
                  background="bg-surface-secondary"
                  padding="400"
                  borderRadius="200"
                >
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">
                      {policy.templates[contentLocale].title}
                    </Text>
                    <Text as="p" variant="bodyMd">
                      {policy.templates[contentLocale].description}
                    </Text>
                    <Button size="slim">
                      {policy.templates[contentLocale].actionLabel}
                    </Button>
                  </BlockStack>
                </Box>
              </BlockStack>
            </Card>
          </>
        )}
      </BlockStack>
    </Page>
  );
}
