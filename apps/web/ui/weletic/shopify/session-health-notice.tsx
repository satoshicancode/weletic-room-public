"use client";

import type { ShopifySessionHealth } from "@/lib/weletic/shopify/session-health-contract";
import { fetcher } from "@dub/utils";
import React from "react";
import useSWR from "swr";

export function ShopifySessionHealthNotice({
  workspaceId,
}: {
  workspaceId?: string;
}) {
  const noticeHeadingId = React.useId();
  const { data, error, isLoading } = useSWR<ShopifySessionHealth>(
    workspaceId
      ? `/api/weletic/shopify/session-health?workspaceId=${encodeURIComponent(workspaceId)}`
      : null,
    fetcher,
    { refreshInterval: 60_000, keepPreviousData: false },
  );
  if (!workspaceId) return null;
  if (data?.status === "reconnect_required")
    return (
      <div
        role="alert"
        aria-labelledby={noticeHeadingId}
        className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
      >
        <p id={noticeHeadingId} className="font-semibold">
          Shopify reconnection required
        </p>
        <p>
          A missing Shopify session was reported. A workspace owner should
          reconnect the Shopify integration if it has not already been repaired.
          Existing points, rewards and reviews are preserved.
        </p>
        {error && (
          <p>
            We could not refresh this alert. The last reported issue remains
            visible.
          </p>
        )}
      </div>
    );
  if (error)
    return (
      <p role="status" className="text-sm text-neutral-600">
        Shopify connection status is unavailable. Try refreshing this page.
      </p>
    );
  if (isLoading)
    return (
      <p role="status" className="text-sm text-neutral-600">
        Checking Shopify connection alerts…
      </p>
    );
  if (data?.status === "not_connected")
    return (
      <p role="status" className="text-sm text-neutral-600">
        No active Shopify installation was found for this workspace.
      </p>
    );
  return null;
}
