"use client";

import useProgram from "@/lib/swr/use-program";
import useWorkspace from "@/lib/swr/use-workspace";
import { Button, LoadingSpinner } from "@dub/ui";
import { fetcher } from "@dub/utils";
import { FormEvent, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";

interface CommerceRule {
  id: string;
  logicalKey: string;
  version: number;
  scope:
    | "program"
    | "partner"
    | "collection"
    | "product"
    | "variant"
    | "promotion"
    | "tag";
  ruleType: "percentage" | "fixed";
  fixedAmountMode: "order" | "line" | "item";
  basisPoints: number | null;
  fixedAmount: string | null;
  currency: string | null;
  priority: number;
  active: boolean;
  productId: string | null;
  variantId: string | null;
  collectionExternalId: string | null;
  promotionCode: string | null;
  tag: string | null;
  effectiveAt: string;
}

interface CatalogProduct {
  id: string;
  title: string;
  handle: string;
  variants: Array<{ id: string; title: string; sku: string | null }>;
}

const INPUT_CLASS_NAME =
  "h-10 w-full rounded-lg border border-neutral-200 bg-white px-3 text-sm";

export function CommerceRulesClient() {
  const { id: workspaceId } = useWorkspace();
  const { program } = useProgram();
  const rulesKey = workspaceId
    ? `/api/weletic/commission-rules?workspaceId=${workspaceId}`
    : undefined;
  const productsKey = workspaceId
    ? `/api/weletic/products?workspaceId=${workspaceId}`
    : undefined;
  const {
    data: rules,
    isLoading,
    mutate,
  } = useSWR<CommerceRule[]>(rulesKey, fetcher);
  const { data: products } = useSWR<CatalogProduct[]>(productsKey, fetcher);
  const [submitting, setSubmitting] = useState(false);
  const [scope, setScope] = useState<CommerceRule["scope"]>("program");
  const [ruleType, setRuleType] =
    useState<CommerceRule["ruleType"]>("percentage");
  const [productId, setProductId] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!workspaceId) return;
    const formElement = event.currentTarget;
    setSubmitting(true);
    const form = new FormData(formElement);
    const amount = String(form.get("amount") ?? "0");
    const payload = {
      logicalKey: String(form.get("logicalKey") ?? "").trim() || undefined,
      scope,
      ruleType,
      priority: Number(form.get("priority") ?? 0),
      fixedAmountMode: form.get("fixedAmountMode") ?? "line",
      basisPoints:
        ruleType === "percentage" ? Math.round(Number(amount) * 100) : null,
      fixedAmount: ruleType === "fixed" ? amount : null,
      currency: ruleType === "fixed" ? program?.accountingCurrency : null,
      partnerId: scope === "partner" ? form.get("partnerId") : null,
      productId: scope === "product" ? productId : null,
      variantId: scope === "variant" ? form.get("variantId") : null,
      collectionExternalId:
        scope === "collection" ? form.get("collectionExternalId") : null,
      promotionCode: scope === "promotion" ? form.get("promotionCode") : null,
      effectiveAt: new Date().toISOString(),
    };
    try {
      const response = await fetch(
        `/api/weletic/commission-rules?workspaceId=${workspaceId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message ?? result.message);
      toast.success("Commission rule published.");
      formElement.reset();
      await mutate();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Rule could not be created.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const selectedProduct = products?.find((product) => product.id === productId);

  return (
    <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
      <form
        onSubmit={submit}
        className="h-fit space-y-4 rounded-xl border border-neutral-200 bg-white p-5"
      >
        <div>
          <h2 className="font-semibold text-neutral-900">Publish a rule</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Publishing creates an immutable version used by future orders.
          </p>
        </div>
        <Field label="Rule key">
          <input
            name="logicalKey"
            className={INPUT_CLASS_NAME}
            placeholder="e.g. default or summer-2026"
          />
          <span className="block text-xs font-normal text-neutral-500">
            Reusing a key supersedes its active version.
          </span>
        </Field>
        <Field label="Scope">
          <select
            value={scope}
            onChange={(event) =>
              setScope(event.target.value as CommerceRule["scope"])
            }
            className={INPUT_CLASS_NAME}
          >
            {(
              [
                "program",
                "partner",
                "collection",
                "product",
                "variant",
                "promotion",
              ] as const
            ).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>
        {scope === "partner" && (
          <Field label="Partner ID">
            <input name="partnerId" required className={INPUT_CLASS_NAME} />
          </Field>
        )}
        {(scope === "product" || scope === "variant") && (
          <Field label="Product">
            <select
              value={productId}
              onChange={(event) => setProductId(event.target.value)}
              required
              className={INPUT_CLASS_NAME}
            >
              <option value="">Select product</option>
              {products?.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.title}
                </option>
              ))}
            </select>
          </Field>
        )}
        {scope === "variant" && (
          <Field label="Variant">
            <select name="variantId" required className={INPUT_CLASS_NAME}>
              <option value="">Select variant</option>
              {selectedProduct?.variants.map((variant) => (
                <option key={variant.id} value={variant.id}>
                  {variant.title}
                  {variant.sku ? ` · ${variant.sku}` : ""}
                </option>
              ))}
            </select>
          </Field>
        )}
        {scope === "collection" && (
          <Field label="Shopify collection GID">
            <input
              name="collectionExternalId"
              required
              className={INPUT_CLASS_NAME}
              placeholder="gid://shopify/Collection/..."
            />
          </Field>
        )}
        {scope === "promotion" && (
          <Field label="Promotion code">
            <input name="promotionCode" required className={INPUT_CLASS_NAME} />
          </Field>
        )}
        <Field label="Reward type">
          <select
            value={ruleType}
            onChange={(event) =>
              setRuleType(event.target.value as CommerceRule["ruleType"])
            }
            className={INPUT_CLASS_NAME}
          >
            <option value="percentage">Percentage</option>
            <option value="fixed">Fixed amount (minor units)</option>
          </select>
        </Field>
        <Field
          label={
            ruleType === "percentage"
              ? "Percentage"
              : `Amount in ${program?.accountingCurrency ?? "USD"} minor units`
          }
        >
          <input
            name="amount"
            type="number"
            min="0"
            step={ruleType === "percentage" ? "0.01" : "1"}
            required
            className={INPUT_CLASS_NAME}
          />
        </Field>
        {ruleType === "fixed" && (
          <Field label="Fixed amount applies per">
            <select
              name="fixedAmountMode"
              defaultValue="line"
              className={INPUT_CLASS_NAME}
            >
              <option value="order">Order</option>
              <option value="line">Line</option>
              <option value="item">Item</option>
            </select>
          </Field>
        )}
        <Field label="Priority">
          <input
            name="priority"
            type="number"
            defaultValue="0"
            min="-1000"
            max="1000"
            className={INPUT_CLASS_NAME}
          />
        </Field>
        <Button
          text="Publish rule"
          type="submit"
          loading={submitting}
          className="w-full"
        />
      </form>

      <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
        <div className="border-b border-neutral-200 px-5 py-4">
          <h2 className="font-semibold text-neutral-900">Rule history</h2>
        </div>
        {isLoading ? (
          <div className="flex min-h-40 items-center justify-center">
            <LoadingSpinner />
          </div>
        ) : !rules?.length ? (
          <div className="p-8 text-center text-sm text-neutral-500">
            No commerce rules yet.
          </div>
        ) : (
          <div className="divide-y divide-neutral-100">
            {rules.map((rule) => (
              <div
                key={rule.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 text-sm"
              >
                <span className="w-24 font-medium capitalize text-neutral-900">
                  {rule.scope}
                </span>
                <span className="min-w-32 text-neutral-600">
                  {rule.ruleType === "percentage"
                    ? `${(rule.basisPoints ?? 0) / 100}%`
                    : `${rule.fixedAmount} ${rule.currency} / ${rule.fixedAmountMode}`}
                </span>
                <span className="text-neutral-500">
                  priority {rule.priority}
                </span>
                <span className="ml-auto rounded-full bg-neutral-100 px-2 py-1 text-xs text-neutral-600">
                  v{rule.version} · {rule.active ? "active" : "superseded"}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5 text-sm font-medium text-neutral-700">
      <span>{label}</span>
      {children}
    </label>
  );
}
