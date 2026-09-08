"use client";

import useWorkspace from "@/lib/swr/use-workspace";
import type { MerchantShopperDirectory } from "@/lib/weletic/shoppers/directory";
import type { MerchantShopperProfile } from "@/lib/weletic/shoppers/profile";
import { useRouter, useSearchParams } from "next/navigation";
import React from "react";
import { ShopperBrowser } from "./shopper-browser";

async function request<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("Shopper data unavailable");
  return response.json();
}
export function ShoppersAdmin() {
  const { id, slug, loading, error } = useWorkspace({
    swrOpts: { keepPreviousData: false },
  });
  const params = useSearchParams();
  const router = useRouter();
  if (error)
    return React.createElement(
      "p",
      { role: "alert" },
      "Workspace access is unavailable.",
    );
  if (loading || !id || !slug) return <p role="status">Loading workspace…</p>;
  const base = `/api/weletic/shoppers?workspaceId=${encodeURIComponent(id)}`;
  return (
    <ShopperBrowser
      key={id}
      shopperId={params.get("shopperId")}
      onSelect={(shopperId) =>
        router.push(
          `/${slug}/shoppers${shopperId ? `?${new URLSearchParams({ shopperId })}` : ""}`,
        )
      }
      transport={{
        scopeKey: id,
        list: (query) =>
          request<MerchantShopperDirectory>(
            `${base}&${new URLSearchParams(query)}`,
          ),
        profile: (query) =>
          request<MerchantShopperProfile>(
            `/api/weletic/shoppers/profile?${new URLSearchParams({ workspaceId: id, ...query })}`,
          ),
      }}
    />
  );
}
