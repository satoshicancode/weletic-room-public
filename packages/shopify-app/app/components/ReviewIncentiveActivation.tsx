import { useEffect, useId, useRef, useState } from "react";
import type { createMerchantReviewIncentivesClient } from "../merchant-review-incentives-client";
import { reviewIncentiveActivationCopy } from "../review-incentive-activation-copy";
import { reviewIncentiveEditorCopy } from "../review-incentive-editor-copy";
import { StaffAccessClientError } from "../staff-access-client";

type Client = ReturnType<typeof createMerchantReviewIncentivesClient>;
type Policy = Awaited<ReturnType<Client["read"]>>;
export function ReviewIncentiveActivation({
  policy,
  locale,
  activate,
  cancel,
  reload,
}: {
  policy: Policy;
  locale: keyof typeof reviewIncentiveActivationCopy;
  activate: Client["activate"];
  cancel: () => void;
  reload: () => void;
}) {
  const copy = reviewIncentiveActivationCopy[locale];
  const common = reviewIncentiveEditorCopy[locale];
  const [checked, setChecked] = useState(false);
  const [status, setStatus] = useState<
    "idle" | "busy" | "success" | "uncertain" | "denied" | "auth" | "stale"
  >("idle");
  const latch = useRef(false);
  const mounted = useRef(false);
  const notice = useRef<HTMLParagraphElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const latest = policy.latestPolicy;
  const fingerprint = JSON.stringify([
    policy.installationGeneration,
    policy.revision,
    policy.activePolicy?.policyId,
    latest?.policyId,
    latest?.contentDigest,
  ]);
  const initial = useRef(fingerprint);
  const stale = initial.current !== fingerprint;
  const eligible =
    !!latest &&
    latest.disclosureState === "available" &&
    !!latest.disclosure &&
    latest.revision === policy.revision &&
    latest.policyId !== policy.activePolicy?.policyId;
  useEffect(() => {
    mounted.current = true;
    heading.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (status !== "idle" && status !== "busy") notice.current?.focus();
  }, [status]);
  const message = stale
    ? common.stale
    : status === "denied"
      ? common.denied
      : status === "auth"
        ? common.auth
        : status === "stale"
          ? common.stale
          : status === "idle"
            ? ""
            : copy[status];
  return (
    <section
      aria-labelledby={`${id}-heading`}
      style={{ minWidth: 0, overflowWrap: "anywhere" }}
    >
      <h2 ref={heading} tabIndex={-1} id={`${id}-heading`}>
        {copy.heading}
      </h2>
      <p>{copy.help}</p>
      {latest?.disclosure?.[locale].map((text, index) => (
        <p key={index}>{text}</p>
      )) ?? <p>{common.unavailable}</p>}
      <p ref={notice} role="status" tabIndex={-1}>
        {message}
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (
            !eligible ||
            !latest ||
            !checked ||
            stale ||
            status !== "idle" ||
            latch.current
          )
            return;
          latch.current = true;
          setStatus("busy");
          try {
            await activate({
              expectedRevision: policy.revision,
              expectedInstallationGeneration: policy.installationGeneration,
              expectedActivePolicyId: policy.activePolicy?.policyId ?? null,
              policyId: latest.policyId,
              contentDigest: latest.contentDigest,
            });
            if (mounted.current) setStatus("success");
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
                        : "uncertain"
                  : "uncertain",
              );
          }
          // Retain latch after all outcomes: reconcile by explicit fresh read.
        }}
      >
        <fieldset
          disabled={!eligible || stale || status !== "idle"}
          style={{ minWidth: 0, padding: 0, border: 0 }}
        >
          <label>
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => setChecked(event.target.checked)}
            />{" "}
            {copy.acknowledge}
          </label>
          <button type="submit" disabled={!checked}>
            {status === "busy" ? copy.busy : copy.confirm}
          </button>
        </fieldset>
      </form>
      {status === "idle" && !stale ? (
        <button type="button" onClick={cancel}>
          {copy.cancel}
        </button>
      ) : (
        <button type="button" disabled={status === "busy"} onClick={reload}>
          {common.reload}
        </button>
      )}
    </section>
  );
}
