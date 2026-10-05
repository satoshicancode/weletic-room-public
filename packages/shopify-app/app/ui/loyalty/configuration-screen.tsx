import React from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Banner,
  BlockStack,
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
import useSWR, { SWRConfig } from "swr";
import {
  loyaltyConfigurationUpdateSchema,
  type LoyaltyConfigurationResponse,
  type LoyaltyConfigurationUpdate,
} from "@weletic/contracts/loyalty/configuration-contract";
import {
  loyaltyConfigurationCopy,
  type LoyaltyConfigurationLocale,
} from "./configuration-copy";

export type LoyaltyConfigurationTransport = {
  scopeKey: string;
  read: () => Promise<LoyaltyConfigurationResponse>;
  save: (
    input: LoyaltyConfigurationUpdate,
  ) => Promise<LoyaltyConfigurationResponse>;
};

type Notice = "saved" | "error" | null;
type Settings = NonNullable<
  LoyaltyConfigurationResponse["program"]
>["settings"];
type Field = {
  key: keyof typeof loyaltyConfigurationCopy.en.fields;
  kind: "text" | "integer" | "decimal" | "boolean" | "select";
  options?: readonly (keyof typeof loyaltyConfigurationCopy.en.options)[];
  maximum?: number;
};
const groups: Array<{
  key: "general" | "vip" | "finance" | "lifecycle";
  owner?: boolean;
  fields: Field[];
}> = [
  {
    key: "general",
    fields: [
      { key: "name", kind: "text" },
      { key: "pointNameSingular", kind: "text" },
      { key: "pointNamePlural", kind: "text" },
      { key: "pointsPerCurrencyUnit", kind: "decimal" },
      { key: "holdingPeriodDays", kind: "integer", maximum: 365 },
      { key: "pointsExpiryMonths", kind: "integer", maximum: 24 },
      { key: "pointsExpiryDays", kind: "integer", maximum: 730 },
      { key: "pointsExpiryWarningDays", kind: "integer", maximum: 730 },
      { key: "pointsExpiryLastChanceDays", kind: "integer", maximum: 730 },
      { key: "pointsExpiryWarningEnabled", kind: "boolean" },
      { key: "pointsExpiryLastChanceEnabled", kind: "boolean" },
    ],
  },
  {
    key: "vip",
    fields: [
      {
        key: "vipMilestoneMode",
        kind: "select",
        options: ["amount_spent", "points_earned", "both"],
      },
      {
        key: "vipTimeframe",
        kind: "select",
        options: ["rolling_12m", "calendar_year", "lifetime"],
      },
      { key: "vipDowngradeGraceDays", kind: "integer", maximum: 365 },
      { key: "vipAutoDowngradeEnabled", kind: "boolean" },
    ],
  },
  {
    key: "finance",
    owner: true,
    fields: [
      { key: "liabilityMinorUnitsNumerator", kind: "decimal" },
      { key: "liabilityPointsDenominator", kind: "decimal" },
    ],
  },
  {
    key: "lifecycle",
    owner: true,
    fields: [
      {
        key: "status",
        kind: "select",
        options: ["draft", "test", "active", "disabled"],
      },
      { key: "killSwitchActive", kind: "boolean" },
    ],
  },
];

function draftSettings(locale: LoyaltyConfigurationLocale): Settings {
  const text = loyaltyConfigurationCopy[locale];
  return {
    name: text.title,
    status: "draft",
    pointNameSingular: text.point,
    pointNamePlural: text.points,
    pointsPerCurrencyUnit: "1",
    holdingPeriodDays: 0,
    pointsExpiryMonths: 0,
    pointsExpiryDays: 0,
    pointsExpiryWarningDays: 30,
    pointsExpiryLastChanceDays: 3,
    pointsExpiryWarningEnabled: true,
    pointsExpiryLastChanceEnabled: true,
    killSwitchActive: false,
    vipMilestoneMode: "amount_spent",
    vipTimeframe: "rolling_12m",
    vipDowngradeGraceDays: 30,
    vipAutoDowngradeEnabled: true,
    liabilityValuationCurrency: null,
    liabilityMinorUnitsNumerator: null,
    liabilityPointsDenominator: null,
  };
}

export function LoyaltyConfigurationSession({
  transport,
}: {
  transport: LoyaltyConfigurationTransport;
}) {
  const cache = React.useMemo(() => ({ provider: () => new Map() }), []);
  return (
    <SWRConfig value={cache}>
      <LoyaltyConfigurationScreen transport={transport} />
    </SWRConfig>
  );
}

export function LoyaltyConfigurationScreen({
  transport,
}: {
  transport: LoyaltyConfigurationTransport;
}) {
  const shopify = useAppBridge();
  const [locale, setLocale] = React.useState<LoyaltyConfigurationLocale>("en");
  const text = loyaltyConfigurationCopy[locale];
  const visit = React.useId();
  const scopeVisit = React.useRef({ scope: transport.scopeKey, sequence: 0 });
  if (scopeVisit.current.scope !== transport.scopeKey)
    scopeVisit.current = {
      scope: transport.scopeKey,
      sequence: scopeVisit.current.sequence + 1,
    };
  const writePending = React.useRef(false);
  const [busy, setBusy] = React.useState(false);
  const [blockedScope, setBlockedScope] = React.useState<string>();
  const [notice, setNotice] = React.useState<{
    scope: string;
    value: Notice;
  }>();
  const { data, error, mutate, isLoading, isValidating } = useSWR(
    [
      "loyalty-configuration",
      transport.scopeKey,
      scopeVisit.current.sequence,
      visit,
    ],
    transport.read,
    { keepPreviousData: false, shouldRetryOnError: false },
  );

  async function save(input: LoyaltyConfigurationUpdate) {
    if (
      writePending.current ||
      !data?.capabilities.configure ||
      blockedScope === transport.scopeKey
    )
      return;
    writePending.current = true;
    setBusy(true);
    const scope = transport.scopeKey;
    setNotice({ scope, value: null });
    try {
      await transport.save(input);
      await mutate();
      setNotice({ scope, value: "saved" });
      shopify.toast?.show?.(text.saved);
    } catch {
      setBlockedScope(scope);
      setNotice({ scope, value: "error" });
      shopify.toast?.show?.(text.error, { isError: true });
    } finally {
      writePending.current = false;
      setBusy(false);
    }
  }

  async function reload() {
    const recoveryVisit = scopeVisit.current;
    try {
      if ((await mutate()) && scopeVisit.current === recoveryVisit) {
        setBlockedScope(undefined);
        setNotice({ scope: transport.scopeKey, value: null });
      }
    } catch {
      /* Explicit recovery must succeed before editing resumes. */
    }
  }

  return (
    <Page title={text.title}>
      <BlockStack gap="500">
        <InlineStack align="end">
          <Select
            label={text.language}
            labelInline
            options={[
              { label: "English", value: "en" },
              { label: "日本語", value: "ja" },
              { label: "Tiếng Việt", value: "vi" },
            ]}
            value={locale}
            onChange={(val) => setLocale(val as LoyaltyConfigurationLocale)}
          />
        </InlineStack>

        {notice?.scope === transport.scopeKey && notice.value && (
          <Banner tone={notice.value === "saved" ? "success" : "critical"}>
            <p>{text[notice.value]}</p>
          </Banner>
        )}

        {error || blockedScope === transport.scopeKey ? (
          <Banner
            tone="critical"
            action={{
              content: text.reload,
              onAction: () => void reload(),
              loading: busy || isValidating,
            }}
          >
            <p>{text.unavailable}</p>
          </Banner>
        ) : isLoading || !data ? (
          <Card>
            <Text as="p" tone="subdued">
              {text.loading}
            </Text>
          </Card>
        ) : (
          <ConfigurationEditor
            key={`${transport.scopeKey}:${data.installationGeneration}:${data.configurationRevision}`}
            data={data}
            locale={locale}
            busy={busy || isValidating}
            save={save}
          />
        )}
      </BlockStack>
    </Page>
  );
}

function ConfigurationEditor({
  data,
  locale,
  busy,
  save,
}: {
  data: LoyaltyConfigurationResponse;
  locale: LoyaltyConfigurationLocale;
  busy: boolean;
  save: (input: LoyaltyConfigurationUpdate) => Promise<void>;
}) {
  const shopify = useAppBridge();
  const text = loyaltyConfigurationCopy[locale];
  const [initial] = React.useState(
    () => data.program?.settings ?? draftSettings(locale),
  );
  const [values, setValues] = React.useState<Record<string, unknown>>(() => ({
    ...initial,
  }));
  const [message, setMessage] = React.useState<"invalid" | "unchanged" | null>(
    null,
  );
  const coreLaunch = data.capabilities.coreLaunch === true;
  const visibleGroups = coreLaunch
    ? groups
        .filter((group) => group.key !== "vip")
        .map((group) => ({
          ...group,
          fields: group.fields.filter(
            (field) => !field.key.startsWith("pointsExpiry"),
          ),
        }))
    : groups;
  const writable = data.capabilities.configure && !busy;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!writable) return;
    const patch: Record<string, unknown> = {};
    for (const group of visibleGroups) {
      if (group.owner && !data.capabilities.owner) continue;
      if (group.key === "lifecycle" && !data.program) continue;
      for (const field of group.fields) {
        const val = values[field.key];
        const value =
          field.kind === "boolean"
            ? Boolean(val)
            : field.kind === "integer"
              ? typeof val === "number"
                ? val
                : typeof val === "string" && val.trim() !== ""
                  ? Number(val)
                  : NaN
              : typeof val === "string"
                ? val.trim()
                : String(val ?? "").trim();
        const current = initial[field.key] ?? "";
        if (!data.program || value !== current) patch[field.key] = value;
      }
    }
    if (!data.program) {
      patch.name =
        typeof values.name === "string" ? values.name.trim() : values.name;
    }
    if (
      "liabilityMinorUnitsNumerator" in patch ||
      "liabilityPointsDenominator" in patch
    ) {
      const numerator = String(
        values.liabilityMinorUnitsNumerator ?? "",
      ).trim();
      const denominator = String(
        values.liabilityPointsDenominator ?? "",
      ).trim();
      patch.liabilityMinorUnitsNumerator = numerator || null;
      patch.liabilityPointsDenominator = denominator || null;
      patch.liabilityValuationCurrency =
        numerator || denominator ? data.accountingCurrency : null;
    }
    if (Object.keys(patch).length === 0) {
      setMessage("unchanged");
      return;
    }
    const input = loyaltyConfigurationUpdateSchema.safeParse({
      expectedRevision: data.configurationRevision,
      expectedInstallationGeneration: data.installationGeneration,
      settings: patch,
    });
    if (!input.success) {
      setMessage("invalid");
      shopify.toast?.show?.(text.invalid, { isError: true });
      return;
    }
    setMessage(null);
    await save(input.data);
  }

  return (
    <form onSubmit={(event) => void submit(event)}>
      <BlockStack gap="500">
        {!data.program && (
          <Banner tone="info">
            <p>{text.unconfigured}</p>
          </Banner>
        )}
        {!data.capabilities.configure && (
          <Banner tone="warning">
            <p>{text.readOnly}</p>
          </Banner>
        )}
        {!data.capabilities.owner && (
          <Banner tone="info">
            <p>{text.ownerOnly}</p>
          </Banner>
        )}
        {message && (
          <Banner tone={message === "unchanged" ? "info" : "critical"}>
            <p>{text[message]}</p>
          </Banner>
        )}
        {visibleGroups.map((group) => {
          const groupDisabled =
            !writable ||
            Boolean(group.owner && !data.capabilities.owner) ||
            (group.key === "lifecycle" && !data.program);
          return (
            <Card key={group.key}>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  {coreLaunch && group.key === "general"
                    ? text.coreGeneral
                    : text[group.key]}
                </Text>
                {group.key === "finance" && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {text.currency}: {data.accountingCurrency}.{" "}
                    {text.valuationHelp}
                  </Text>
                )}
                {group.key === "general" && !coreLaunch && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {text.expiryHelp}
                  </Text>
                )}
                {group.key === "lifecycle" && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {text.lifecycleHelp}
                  </Text>
                )}
                <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
                  {group.fields.map((field) => {
                    if (field.kind === "boolean") {
                      return (
                        <Checkbox
                          key={field.key}
                          label={text.fields[field.key]}
                          name={field.key}
                          checked={Boolean(values[field.key])}
                          disabled={groupDisabled}
                          onChange={(checked) =>
                            setValues((prev) => ({
                              ...prev,
                              [field.key]: checked,
                            }))
                          }
                        />
                      );
                    }
                    if (field.kind === "select") {
                      return (
                        <Select
                          key={field.key}
                          label={text.fields[field.key]}
                          name={field.key}
                          options={
                            field.options?.map((option) => ({
                              label: text.options[option],
                              value: option,
                            })) ?? []
                          }
                          value={String(values[field.key] ?? "")}
                          disabled={groupDisabled}
                          onChange={(val) =>
                            setValues((prev) => ({
                              ...prev,
                              [field.key]: val,
                            }))
                          }
                        />
                      );
                    }
                    return (
                      <TextField
                        key={field.key}
                        label={text.fields[field.key]}
                        name={field.key}
                        type={field.kind === "integer" ? "number" : "text"}
                        inputMode={
                          field.kind === "decimal"
                            ? "decimal"
                            : field.kind === "integer"
                              ? "numeric"
                              : undefined
                        }
                        min={field.kind === "integer" ? 0 : undefined}
                        max={field.maximum}
                        step={field.kind === "integer" ? 1 : undefined}
                        maxLength={field.kind === "text" ? 191 : 32}
                        value={
                          values[field.key] === undefined ||
                          (typeof values[field.key] === "number" &&
                            Number.isNaN(values[field.key]))
                            ? ""
                            : String(values[field.key])
                        }
                        disabled={groupDisabled}
                        autoComplete="off"
                        onChange={(val) =>
                          setValues((prev) => ({
                            ...prev,
                            [field.key]:
                              field.kind === "integer"
                                ? val.trim() === ""
                                  ? ""
                                  : Number(val)
                                : val,
                          }))
                        }
                      />
                    );
                  })}
                </InlineGrid>
              </BlockStack>
            </Card>
          );
        })}
        <InlineStack align="start">
          <Button
            variant="primary"
            submit={true}
            disabled={!writable}
            loading={busy}
          >
            {data.program ? text.save : text.create}
          </Button>
        </InlineStack>
      </BlockStack>
    </form>
  );
}
