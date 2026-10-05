import React from "react";
import {
  Banner,
  BlockStack,
  Button,
  Checkbox,
  InlineStack,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { isCustomerIntentTriggerCode } from "@weletic/contracts/loyalty/customer-intent-policy";
import type { EarningRuleFields } from "@weletic/contracts/loyalty/earning-rule-contract";
import { requiresUnverifiedSubscriptionCycle } from "@weletic/contracts/loyalty/purchase-policy";
import { useCoreLaunch } from "~/core-launch-context";
import { earningRuleCopy, type EarningRuleLocale } from "./earning-rule-copy";
import {
  changeEarningRuleTrigger,
  parseEarningRuleForm,
  type EarningRuleForm,
} from "./earning-rule-form";

export function EarningRuleEditor({
  value,
  onChange,
  onSubmit,
  onCancel,
  disabled = false,
  locale = "en",
}: {
  value: EarningRuleForm;
  onChange: (value: EarningRuleForm) => void;
  onSubmit: (fields: EarningRuleFields) => void;
  onCancel: () => void;
  disabled?: boolean;
  locale?: EarningRuleLocale;
}) {
  const coreLaunch = useCoreLaunch();
  const copy = earningRuleCopy[locale];
  const [invalid, setInvalid] = React.useState<string[]>([]);
  const update = <K extends keyof EarningRuleForm>(
    key: K,
    field: EarningRuleForm[K],
  ) => {
    setInvalid([]);
    onChange({ ...value, [key]: field });
  };

  const text = (key: keyof EarningRuleForm, numeric = false) => (
    <TextField
      key={key}
      label={copy.fields[key]}
      name={key}
      value={String(value[key] ?? "")}
      inputMode={numeric ? "decimal" : "text"}
      error={invalid.includes(key)}
      disabled={disabled}
      autoComplete="off"
      onChange={(val) => update(key, val)}
    />
  );

  const select = <
    K extends
      | "triggerCode"
      | "limitInterval"
      | "provider"
      | "purchaseType"
      | "subscriptionCadence",
  >(
    key: K,
    options: Record<EarningRuleForm[K], string>,
  ) => {
    const optionEntries = Object.entries<string>(options)
      .filter(
        ([optionKey]) =>
          !coreLaunch ||
          (key !== "triggerCode" && key !== "purchaseType") ||
          (key === "triggerCode"
            ? optionKey === "order_paid"
            : optionKey === "one_time"),
      )
      .map(([optionKey, label]) => ({
        label,
        value: optionKey,
        disabled:
          key === "subscriptionCadence" && optionKey !== "every_payment",
      }));

    return (
      <Select
        key={key}
        label={copy.fields[key]}
        name={key}
        value={value[key]}
        options={optionEntries}
        error={invalid.includes(key)}
        disabled={disabled}
        onChange={(val) => {
          const selected = val as EarningRuleForm[K];
          if (!Object.hasOwn(options, selected)) return;
          if (key === "triggerCode") {
            setInvalid([]);
            onChange(
              changeEarningRuleTrigger(
                value,
                selected as EarningRuleForm["triggerCode"],
              ),
            );
          } else if (key === "purchaseType") {
            setInvalid([]);
            onChange({
              ...value,
              purchaseType: selected as EarningRuleForm["purchaseType"],
              subscriptionCadence:
                selected === "one_time"
                  ? "first_payment"
                  : value.subscriptionCadence,
              subscriptionPaymentLimit:
                selected === "one_time" ? "" : value.subscriptionPaymentLimit,
            });
          } else {
            update(key, selected);
          }
        }}
      />
    );
  };

  const checkbox = (key: "isActive" | "excludeDiscountedItems") => (
    <Checkbox
      key={key}
      label={copy.fields[key]}
      name={key}
      checked={Boolean(value[key])}
      disabled={disabled}
      onChange={(checked) => update(key, checked)}
    />
  );

  const order = value.triggerCode === "order_paid";
  const social = isCustomerIntentTriggerCode(value.triggerCode);

  return (
    <form
      lang={locale}
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        const parsed = parseEarningRuleForm(value);
        if (!parsed.success) {
          setInvalid(
            parsed.error.issues.flatMap((issue) =>
              issue.path[0] === "conditions"
                ? [
                    "targetUrl",
                    "shareMessage",
                    "provider",
                    "minContentLength",
                    "photoBonusPoints",
                    "videoBonusPoints",
                  ]
                : [String(issue.path[0])],
            ),
          );
          return;
        }
        if (
          parsed.data.triggerCode === "order_paid" &&
          parsed.data.isActive &&
          requiresUnverifiedSubscriptionCycle(parsed.data)
        ) {
          setInvalid(["subscriptionCadence"]);
          return;
        }
        onSubmit(parsed.data);
      }}
    >
      <BlockStack gap="400">
        {text("name")}
        {text("description")}
        {select("triggerCode", copy.triggers)}
        <Text as="p" variant="bodySm" tone="subdued">
          {copy.reset}
        </Text>
        {text("priority", true)}
        {order ? (
          <>
            {text("multiplier", true)}
            {text("minOrderSubtotal", true)}
            {select("purchaseType", copy.purchaseTypes)}
            {value.purchaseType !== "one_time" && (
              <>
                {select("subscriptionCadence", copy.subscriptionCadences)}
                <Text as="p" variant="bodySm" tone="caution">
                  {copy.cadenceUnavailable}
                </Text>
                {value.subscriptionCadence === "first_n_payments" &&
                  text("subscriptionPaymentLimit", true)}
              </>
            )}
            {checkbox("excludeDiscountedItems")}
            <Text as="p" variant="bodySm" tone="subdued">
              {copy.purchase}
            </Text>
          </>
        ) : (
          <>
            {text("fixedPoints", true)}
            {text("maxEventsPerCustomer", true)}
            {select("limitInterval", copy.periods)}
          </>
        )}
        {text("maxPointsPerEvent", true)}
        {social && (
          <>
            {text("targetUrl")}
            {["facebook_share", "x_share"].includes(value.triggerCode) &&
              text("shareMessage")}
            <Text as="p" variant="bodySm" tone="subdued">
              {copy.honor}
            </Text>
          </>
        )}
        {value.triggerCode === "product_review" && (
          <>
            {select("provider", copy.providers)}
            {text("minContentLength", true)}
            {text("photoBonusPoints", true)}
            {text("videoBonusPoints", true)}
            <Text as="p" variant="bodySm" tone="subdued">
              {copy.review}
            </Text>
          </>
        )}
        {checkbox("isActive")}
        {invalid.length > 0 && (
          <Banner tone="critical">
            <p>{copy.invalid}</p>
          </Banner>
        )}
        <InlineStack gap="300">
          <Button variant="primary" submit={true} disabled={disabled}>
            {copy.save}
          </Button>
          <Button onClick={onCancel} disabled={disabled}>
            {copy.cancel}
          </Button>
        </InlineStack>
      </BlockStack>
    </form>
  );
}
