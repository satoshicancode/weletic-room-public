import React, { useEffect, useId, useRef, useState } from "react";
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
  loyaltyAppearanceBrandingSchema,
  verifyLoyaltyAppearanceResponse,
  type LoyaltyAppearanceRequest,
  type LoyaltyAppearanceResponse,
} from "@weletic/contracts/loyalty/appearance-contract";
import {
  LOYALTY_LAUNCHER_ICONS,
  LOYALTY_LAUNCHER_POSITIONS,
  type LoyaltyBranding,
} from "@weletic/contracts/loyalty/branding";
import { appearanceCopy } from "./appearance-copy";
import { LauncherPresentationFields } from "./launcher-presentation-fields";

type Locale = keyof typeof appearanceCopy;
export function LoyaltyAppearanceScreen({
  request,
  onNavigationStateChange,
}: {
  request: (
    input: LoyaltyAppearanceRequest,
  ) => Promise<LoyaltyAppearanceResponse>;
  onNavigationStateChange?: (state: { dirty: boolean; locale: Locale }) => void;
}) {
  const shopify = useAppBridge();
  const id = useId();
  const [locale, setLocale] = useState<Locale>("en");
  const [state, setState] = useState<LoyaltyAppearanceResponse | null>(null);
  const [draft, setDraft] = useState<LoyaltyBranding | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<"saved" | "error" | "invalid" | null>(
    null,
  );
  const epoch = useRef(0);
  const inFlight = useRef(false);
  const copy = appearanceCopy[locale];

  useEffect(() => {
    onNavigationStateChange?.({ dirty: dirty || busy, locale });
  }, [dirty, busy, locale, onNavigationStateChange]);

  useEffect(() => {
    const fence = epoch;
    const version = ++fence.current;
    inFlight.current = true;
    setBusy(true);
    setState(null);
    setDraft(null);
    setDirty(false);
    setMessage(null);
    const input = { operation: "read" } as const;
    request(input)
      .then((value) => {
        if (version !== fence.current) return;
        const result = verifyLoyaltyAppearanceResponse(input, value);
        setState(result);
        setDraft(result.branding);
      })
      .catch(() => {
        if (version === fence.current) setMessage("error");
      })
      .finally(() => {
        if (version === fence.current) {
          inFlight.current = false;
          setBusy(false);
        }
      });
    return () => {
      fence.current++;
    };
  }, [request]);

  async function perform(input: LoyaltyAppearanceRequest) {
    if (inFlight.current) return;
    inFlight.current = true;
    const version = ++epoch.current;
    setBusy(true);
    setMessage(null);
    try {
      const result = verifyLoyaltyAppearanceResponse(
        input,
        await request(input),
      );
      if (version !== epoch.current) return;
      setState(result);
      setDraft(result.branding);
      setDirty(false);
      if (input.operation === "save") {
        setMessage("saved");
        shopify.toast?.show?.(copy.saved);
      } else {
        setMessage(null);
      }
    } catch {
      if (version === epoch.current) {
        setState(null);
        setMessage("error");
        shopify.toast?.show?.(copy.error, { isError: true });
      }
    } finally {
      if (version === epoch.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }

  function change<K extends keyof LoyaltyBranding>(
    key: K,
    value: LoyaltyBranding[K],
  ) {
    if (!draft || inFlight.current) return;
    setDraft({ ...draft, [key]: value });
    setDirty(true);
    setMessage(null);
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    if (
      !state?.capabilities.configure ||
      !state.programConfigured ||
      !draft ||
      inFlight.current
    )
      return;
    const parsed = loyaltyAppearanceBrandingSchema.safeParse(draft);
    if (!parsed.success) {
      setMessage("invalid");
      return;
    }
    void perform({
      operation: "save",
      expectedInstallationGeneration: state.installationGeneration,
      expectedRevision: state.revision,
      branding: parsed.data,
    });
  }

  const disabled =
    busy || !state?.capabilities.configure || !state.programConfigured;

  return (
    <section
      className="weletic-communications"
      lang={locale}
      aria-busy={busy}
      aria-labelledby={`${id}-title`}
    >
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd" id={`${id}-title`}>
          {copy.title}
        </Text>
        <Text as="p" tone="subdued">
          {copy.note}
        </Text>
        <Select
          label={copy.language}
          value={locale}
          options={[
            { label: "English", value: "en" },
            { label: "日本語", value: "ja" },
            { label: "Tiếng Việt", value: "vi" },
          ]}
          onChange={(val) => setLocale(val as Locale)}
        />
        {busy && <p role="status">{copy.loading}</p>}
        {message === "saved" && (
          <Banner tone="success" onDismiss={() => setMessage(null)}>
            <p role="status">{copy.saved}</p>
          </Banner>
        )}
        {message === "error" && (
          <Banner tone="critical" onDismiss={() => setMessage(null)}>
            <p role="alert">{copy.error}</p>
          </Banner>
        )}
        {message === "invalid" && (
          <Banner tone="warning" onDismiss={() => setMessage(null)}>
            <p role="alert">{copy.invalid}</p>
          </Banner>
        )}
        {state && !state.programConfigured && (
          <Banner tone="warning">
            <p>{copy.missing}</p>
          </Banner>
        )}
        <form onSubmit={save}>
          <Card>
            <BlockStack gap="400">
              <Text as="h3" variant="headingSm">
                {copy.title}
              </Text>
              {draft && (
                <>
                  {(
                    [
                      "launcherText",
                      "panelTitle",
                      "panelWelcomeSubtitle",
                      "primaryColor",
                      "headerTextColor",
                      "heroImageUrl",
                    ] as const
                  ).map((key) => (
                    <TextField
                      key={key}
                      id={`${id}-${key}`}
                      name={key}
                      disabled={disabled}
                      label={copy[key]}
                      autoComplete="off"
                      value={draft[key] ?? ""}
                      maxLength={
                        key === "launcherText"
                          ? 40
                          : key === "panelTitle"
                            ? 100
                            : key === "panelWelcomeSubtitle"
                              ? 300
                              : key === "heroImageUrl"
                                ? 2048
                                : 7
                      }
                      onChange={(val) => change(key, val)}
                    />
                  ))}
                  <Select
                    label={copy.launcherPosition}
                    disabled={disabled}
                    options={LOYALTY_LAUNCHER_POSITIONS.map((val) => ({
                      label: copy[val],
                      value: val,
                    }))}
                    value={draft.launcherPosition}
                    onChange={(val) =>
                      change(
                        "launcherPosition",
                        val as LoyaltyBranding["launcherPosition"],
                      )
                    }
                  />
                  <Select
                    label={copy.launcherIcon}
                    disabled={disabled}
                    options={LOYALTY_LAUNCHER_ICONS.map((val) => ({
                      label: copy[val],
                      value: val,
                    }))}
                    value={draft.launcherIcon}
                    onChange={(val) =>
                      change(
                        "launcherIcon",
                        val as LoyaltyBranding["launcherIcon"],
                      )
                    }
                  />
                  <Checkbox
                    label={copy.enableFloatingLauncher}
                    disabled={disabled}
                    checked={draft.enableFloatingLauncher}
                    onChange={(val) =>
                      change("enableFloatingLauncher", val)
                    }
                  />
                  <LauncherPresentationFields
                    value={draft.launcherPresentation}
                    locale={locale}
                    onChange={(val) => change("launcherPresentation", val)}
                  />
                </>
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
                  disabled={busy}
                  onClick={() => {
                    if (!dirty || window.confirm(copy.discard))
                      void perform({ operation: "read" });
                  }}
                >
                  {copy.reload}
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </form>
      </BlockStack>
    </section>
  );
}
