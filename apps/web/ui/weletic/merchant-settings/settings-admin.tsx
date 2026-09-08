"use client";
import useWorkspace from "@/lib/swr/use-workspace";
import { merchantSettingsResponseSchema } from "@/lib/weletic/merchant-settings/merchant-contract";
import React from "react";
import { MerchantSettingsScreen } from "./settings-form";

async function request<T>(
  url: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const result = await fetch(url, {
    method,
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  if (!result.ok) throw new Error("Merchant settings request failed");
  return result.json();
}
export function MerchantSettingsAdmin() {
  const { id, loading, error, isOwner } = useWorkspace({
    swrOpts: { keepPreviousData: false },
  });
  if (error)
    return React.createElement(
      "p",
      { role: "alert" },
      "Workspace access is unavailable.",
    );
  if (loading || !id) return <p role="status">Loading workspace…</p>;
  const query = `?workspaceId=${encodeURIComponent(id)}`;
  return (
    <MerchantSettingsScreen
      key={id}
      canEdit={Boolean(isOwner)}
      transport={{
        scopeKey: id,
        read: async () =>
          merchantSettingsResponseSchema.parse(
            await request<unknown>(`/api/weletic/merchant-settings${query}`),
          ),
        save: (input) =>
          request(`/api/weletic/merchant-settings${query}`, "PATCH", input),
        loyalty: (input) =>
          request(`/api/shopify/loyalty/admin/settings${query}`, "POST", input),
        reviews: (input) =>
          request(`/api/shopify/reviews/admin${query}`, "POST", {
            action: "module",
            ...input,
          }),
      }}
    />
  );
}
