import { useEffect, useId, useRef, useState } from "react";
import {
  merchantReviewIncentiveDraftInputSchema,
  type MerchantReviewIncentiveDraftInput,
} from "../../../../apps/web/lib/weletic/reviews/incentive-merchant-contract";
import { useCoreLaunch } from "../../../../apps/web/ui/weletic/core-launch-context";
import { isCoreReviewIncentiveDraft } from "../core-review-policy";
import { createMerchantReviewIncentivesClient } from "../merchant-review-incentives-client";
import { reviewIncentiveActivationCopy } from "../review-incentive-activation-copy";
import { reviewIncentiveEditorCopy } from "../review-incentive-editor-copy";
import { StaffAccessClientError } from "../staff-access-client";

type Client = ReturnType<typeof createMerchantReviewIncentivesClient>;
type Policy = Awaited<ReturnType<Client["read"]>>;
type Draft = MerchantReviewIncentiveDraftInput["draft"];
/** Mount keyed by an explicit successful reload epoch AND generation/revision:
 * an ambiguous non-commit can reload the same revision and still needs a reset.
 * Do not silently remount on background refresh and discard dirty input.
 * Coupon choices must
 * come from an authorized catalog reader, never free-text shopper identifiers.
 * This component cannot activate policies; every settled save requires reload.
 */
export function ReviewIncentiveEditor({
  policy,
  coupons,
  visibleCouponIds,
  locale,
  save,
  reload,
  reviewActivation,
  focusHeading = false,
}: {
  policy: Policy;
  coupons: Array<{ id: string; name: string }>;
  visibleCouponIds?: string[];
  locale: keyof typeof reviewIncentiveEditorCopy;
  save: Client["draft"];
  reload: () => void;
  reviewActivation?: () => void;
  focusHeading?: boolean;
}) {
  const copy = reviewIncentiveEditorCopy[locale];
  const coreLaunch = useCoreLaunch();
  const saved = policy.latestPolicy?.draft;
  const initial =
    saved && (!coreLaunch || isCoreReviewIncentiveDraft(saved))
      ? saved
      : { kind: "none" as const };
  const [draft, setDraft] = useState<Draft>(initial);
  const [status, setStatus] = useState<
    | "idle"
    | "invalid"
    | "busy"
    | "saved"
    | "failed"
    | "stale"
    | "denied"
    | "auth"
  >("idle");
  const fence = useRef(`${policy.installationGeneration}:${policy.revision}`);
  const changed =
    fence.current !== `${policy.installationGeneration}:${policy.revision}`;
  const flight = useRef(false);
  const mounted = useRef(false);
  const blocked = changed || !["idle", "invalid"].includes(status);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const id = useId();
  const notice = useRef<HTMLParagraphElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusHeading) heading.current?.focus();
  }, [focusHeading]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (status !== "idle" && status !== "busy") notice.current?.focus();
  }, [status]);
  useEffect(() => {
    if (!dirty || status === "saved") return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, status]);
  const updateKind = (kind: Draft["kind"]) => {
    setDraft(
      kind === "points"
        ? {
            kind,
            basePoints: "0",
            photoBonusPoints: "0",
            videoBonusPoints: "0",
            maxPoints: "0",
          }
        : kind === "coupon"
          ? { kind, rewardDefinitionId: "" }
          : { kind },
    );
  };
  const messages = {
    idle: "",
    invalid: copy.invalid,
    busy: copy.busy,
    saved: copy.saved,
    failed: copy.failed,
    stale: copy.stale,
    denied: copy.denied,
    auth: copy.auth,
  };
  return (
    <section
      aria-labelledby={`${id}-heading`}
      style={{ minWidth: 0, overflowWrap: "anywhere" }}
    >
      <h2 ref={heading} tabIndex={-1} id={`${id}-heading`}>
        {copy.heading}
      </h2>
      <p>{copy.help}</p>
      <p ref={notice} role="status" aria-live="polite" tabIndex={-1}>
        {changed ? copy.stale : messages[status]}
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (blocked || flight.current) return;
          const parsed = merchantReviewIncentiveDraftInputSchema.safeParse({
            expectedRevision: policy.revision,
            expectedInstallationGeneration: policy.installationGeneration,
            draft,
          });
          if (
            !parsed.success ||
            (coreLaunch && !isCoreReviewIncentiveDraft(draft)) ||
            (draft.kind === "coupon" &&
              !coupons.some((coupon) => coupon.id === draft.rewardDefinitionId))
          ) {
            setStatus("invalid");
            return;
          }
          flight.current = true;
          setStatus("busy");
          try {
            await save(parsed.data);
            if (mounted.current) setStatus("saved");
          } catch (error) {
            if (mounted.current)
              setStatus(
                error instanceof StaffAccessClientError
                  ? error.code === "denied"
                    ? "denied"
                    : error.code === "reauthenticate"
                      ? "auth"
                      : error.code === "reload"
                        ? "stale"
                        : "failed"
                  : "failed",
              );
          }
          // Keep the synchronous guard latched after settlement. Even before React
          // flushes its status update, another submit cannot replay this revision.
        }}
      >
        <fieldset
          disabled={blocked}
          style={{
            minWidth: 0,
            border: 0,
            padding: 0,
            display: "grid",
            gap: 12,
          }}
        >
          <label htmlFor={`${id}-kind`}>{copy.kind}</label>
          <select
            id={`${id}-kind`}
            name="kind"
            style={{ width: "100%", minWidth: 0 }}
            value={draft.kind}
            onChange={(event) =>
              updateKind(event.target.value as Draft["kind"])
            }
          >
            {(["none", "points", "coupon"] as const)
              .filter((kind) => !coreLaunch || kind !== "coupon")
              .map((kind) => (
                <option key={kind} value={kind}>
                  {copy[kind]}
                </option>
              ))}
          </select>
          {draft.kind === "points" &&
            (
              [
                ["basePoints", "base"],
                ["photoBonusPoints", "photo"],
                ["videoBonusPoints", "video"],
                ["maxPoints", "cap"],
              ] as const
            )
              .filter(
                ([field]) =>
                  !coreLaunch ||
                  field === "basePoints" ||
                  field === "maxPoints",
              )
              .map(([field, label]) => (
                <div key={field} style={{ display: "grid", gap: 4 }}>
                  <label htmlFor={`${id}-${field}`}>{copy[label]}</label>
                  <input
                    id={`${id}-${field}`}
                    name={field}
                    style={{
                      width: "100%",
                      minWidth: 0,
                      boxSizing: "border-box",
                    }}
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={19}
                    value={draft[field]}
                    onChange={(event) =>
                      setDraft({ ...draft, [field]: event.target.value })
                    }
                  />
                </div>
              ))}
          {draft.kind === "coupon" && (
            <div style={{ display: "grid", gap: 4 }}>
              <label htmlFor={`${id}-coupon`}>{copy.couponLabel}</label>
              <select
                id={`${id}-coupon`}
                name="rewardDefinitionId"
                style={{ width: "100%", minWidth: 0 }}
                value={draft.rewardDefinitionId}
                onChange={(event) =>
                  setDraft({
                    kind: "coupon",
                    rewardDefinitionId: event.target.value,
                  })
                }
              >
                <option value="">{copy.choose}</option>
                {coupons
                  .filter(
                    (coupon) =>
                      !visibleCouponIds ||
                      visibleCouponIds.includes(coupon.id) ||
                      coupon.id === draft.rewardDefinitionId,
                  )
                  .map((coupon) => (
                    <option key={coupon.id} value={coupon.id}>
                      {coupon.name}
                    </option>
                  ))}
              </select>
            </div>
          )}
          <button type="submit">
            {status === "busy" ? copy.busy : copy.save}
          </button>
        </fieldset>
      </form>
      {reviewActivation &&
        (!coreLaunch ||
          isCoreReviewIncentiveDraft(policy.latestPolicy?.draft)) &&
        policy.latestPolicy?.disclosureState === "available" &&
        policy.latestPolicy.policyId !== policy.activePolicy?.policyId && (
          <button
            type="button"
            disabled={blocked || dirty}
            onClick={() => {
              if (!blocked && !dirty && !flight.current) reviewActivation();
            }}
          >
            {reviewIncentiveActivationCopy[locale].review}
          </button>
        )}
      <button
        type="button"
        disabled={status === "busy"}
        onClick={() => {
          if (!dirty || status === "saved" || window.confirm(copy.discard))
            reload();
        }}
      >
        {copy.reload}
      </button>
      {policy.latestPolicy && (
        <aside aria-label={copy.preview}>
          <h3>{copy.preview}</h3>
          {policy.latestPolicy.disclosure?.[locale].map((text, index) => (
            <p key={index}>{text}</p>
          )) ?? <p>{copy.unavailable}</p>}
        </aside>
      )}
    </section>
  );
}
