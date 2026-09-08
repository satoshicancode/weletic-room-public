"use client";
import React from "react";
import { isCustomerIntentTriggerCode } from "../../../lib/weletic/loyalty/customer-intent-policy";
import type { EarningRuleFields } from "../../../lib/weletic/loyalty/earning-rule-contract";
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
  const copy = earningRuleCopy[locale];
  const id = React.useId();
  const [invalid, setInvalid] = React.useState<string[]>([]);
  const update = <K extends keyof EarningRuleForm>(
    key: K,
    field: EarningRuleForm[K],
  ) => {
    setInvalid([]);
    onChange({ ...value, [key]: field });
  };
  const text = (key: keyof EarningRuleForm, numeric = false) => (
    <label key={key} className="grid gap-1 text-sm" htmlFor={`${id}-${key}`}>
      {copy.fields[key]}
      <input
        id={`${id}-${key}`}
        name={key}
        value={String(value[key])}
        inputMode={numeric ? "decimal" : "text"}
        aria-invalid={invalid.includes(key)}
        aria-describedby={invalid.includes(key) ? `${id}-error` : undefined}
        className="w-full rounded border border-neutral-300 px-3 py-2"
        onChange={(event) => update(key, event.target.value)}
      />
    </label>
  );
  const select = <K extends "triggerCode" | "limitInterval" | "provider">(
    key: K,
    options: Record<EarningRuleForm[K], string>,
  ) => (
    <label className="grid gap-1 text-sm" htmlFor={`${id}-${key}`}>
      {copy.fields[key]}
      <select
        id={`${id}-${key}`}
        name={key}
        value={value[key]}
        aria-invalid={invalid.includes(key)}
        aria-describedby={invalid.includes(key) ? `${id}-error` : undefined}
        className="rounded border border-neutral-300 px-3 py-2"
        onChange={(event) => {
          const selected = event.target.value as EarningRuleForm[K];
          if (!Object.hasOwn(options, selected)) return;
          if (key === "triggerCode") {
            setInvalid([]);
            onChange(
              changeEarningRuleTrigger(
                value,
                selected as EarningRuleForm["triggerCode"],
              ),
            );
          } else update(key, selected);
        }}
      >
        {Object.entries<string>(options).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
  const checkbox = (key: "isActive" | "excludeDiscountedItems") => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        name={key}
        checked={value[key]}
        onChange={(event) => update(key, event.target.checked)}
      />
      {copy.fields[key]}
    </label>
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
        onSubmit(parsed.data);
      }}
    >
      <fieldset disabled={disabled} className="grid gap-4 disabled:opacity-60">
        {text("name")}
        {text("description")}
        {select("triggerCode", copy.triggers)}
        <p className="text-sm text-neutral-600">{copy.reset}</p>
        {text("priority", true)}
        {order ? (
          <>
            {text("multiplier", true)}
            {text("minOrderSubtotal", true)}
            {checkbox("excludeDiscountedItems")}
            <p className="text-sm">{copy.purchase}</p>
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
            <p className="text-sm">{copy.honor}</p>
          </>
        )}
        {value.triggerCode === "product_review" && (
          <>
            {select("provider", copy.providers)}
            {text("minContentLength", true)}
            {text("photoBonusPoints", true)}
            {text("videoBonusPoints", true)}
            <p className="text-sm">{copy.review}</p>
          </>
        )}
        {checkbox("isActive")}
        {invalid.length > 0 && (
          <p id={`${id}-error`} role="alert">
            {copy.invalid}
          </p>
        )}
        <div className="flex gap-3">
          <button type="submit" className="rounded border px-4 py-2">
            {copy.save}
          </button>
          <button
            type="button"
            className="rounded border px-4 py-2"
            onClick={onCancel}
          >
            {copy.cancel}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
