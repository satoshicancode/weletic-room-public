"use client";

import useWorkspace from "@/lib/swr/use-workspace";
import { Button } from "@dub/ui";
import { fetcher } from "@dub/utils";
import { useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";

type PayoutProfileReview = {
  id: string;
  country: string;
  payoutCurrency: string;
  provider: string;
  method: string;
  status: "draft" | "pending_verification" | "verified" | "disabled";
  providerAccountConfigured: boolean;
  details?: { accountLabel?: string; accountLast4?: string } | null;
  partner: { id: string; name: string; email: string | null };
};

export function PayoutProfileReviews() {
  const { id: workspaceId, isOwner } = useWorkspace();
  const { data, mutate } = useSWR<PayoutProfileReview[]>(
    workspaceId && isOwner
      ? `/api/weletic/payout-profiles?workspaceId=${workspaceId}`
      : null,
    fetcher,
  );
  const pending = data?.filter(
    ({ status }) => status === "pending_verification",
  );
  const [notes, setNotes] = useState<Record<string, string>>({});

  if (!isOwner || !pending?.length) return null;

  const review = async (
    profile: PayoutProfileReview,
    status: "verified" | "disabled",
  ) => {
    try {
      const response = await fetch(
        `/api/weletic/payout-profiles/${profile.id}?workspaceId=${workspaceId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status, notes: notes[profile.id] || null }),
        },
      );
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error?.message ?? result.message);
      }
      await mutate();
      toast.success(
        status === "verified"
          ? "Payout profile verified."
          : "Payout profile disabled.",
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Profile review failed.",
      );
    }
  };

  return (
    <section className="mb-4 overflow-hidden rounded-xl border border-neutral-200 bg-white">
      <div className="border-b border-neutral-200 px-4 py-3">
        <h2 className="font-semibold text-neutral-900">
          Settlement profiles awaiting review
        </h2>
        <p className="text-sm text-neutral-500">
          Verify the destination before generating localized payout quotes.
        </p>
      </div>
      <div className="divide-y divide-neutral-100">
        {pending.map((profile) => (
          <div
            key={profile.id}
            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
          >
            <div>
              <p className="text-sm font-medium text-neutral-900">
                {profile.partner.name}
              </p>
              <p className="text-xs text-neutral-500">
                {profile.country} · {profile.payoutCurrency} ·{" "}
                {profile.provider}
                {profile.providerAccountConfigured
                  ? " · account connected"
                  : " · account not connected"}
                {profile.details?.accountLast4
                  ? ` · ending ${profile.details.accountLast4}`
                  : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label={`Verification notes for ${profile.partner.name}`}
                value={notes[profile.id] ?? ""}
                onChange={(event) =>
                  setNotes((current) => ({
                    ...current,
                    [profile.id]: event.target.value,
                  }))
                }
                placeholder="Verification notes"
                className="h-8 rounded-md border border-neutral-200 px-2 text-sm"
              />
              <Button
                variant="secondary"
                text="Disable"
                className="h-8 px-3"
                onClick={() => review(profile, "disabled")}
              />
              <Button
                text="Verify"
                className="h-8 px-3"
                onClick={() => review(profile, "verified")}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
