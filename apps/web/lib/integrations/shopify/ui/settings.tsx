"use client";

import { syncShopifyCatalogAction } from "@/lib/actions/partners/sync-shopify-catalog";
import useWorkspace from "@/lib/swr/use-workspace";
import { InstalledIntegrationInfoProps } from "@/lib/types";
import { ShopifySessionHealthNotice } from "@/ui/weletic/shopify/session-health-notice";
import { Button } from "@dub/ui";
import { CheckCircle2, Globe, RefreshCw, ShoppingBag } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";

export const ShopifyIntegrationSettings = ({
  installed,
}: InstalledIntegrationInfoProps) => {
  const { id: workspaceId, shopifyStoreId } = useWorkspace();
  const { mutate } = useSWRConfig();
  const [lastSyncedStats, setLastSyncedStats] = useState<{
    products?: number;
    markets?: number;
    timestamp?: Date;
  } | null>(null);

  const { execute, isPending } = useAction(syncShopifyCatalogAction, {
    onSuccess: ({ data }) => {
      if (data?.stats) {
        setLastSyncedStats({
          products: data.stats.products,
          markets: data.stats.markets,
          timestamp: new Date(),
        });
        toast.success(
          `Đã đồng bộ thành công ${data.stats.products} sản phẩm và ${data.stats.markets} thị trường!`,
        );
      } else {
        toast.success("Đã đồng bộ danh mục Shopify thành công!");
      }
      // Invalidate products and integration SWR cache
      mutate(
        (key) =>
          typeof key === "string" &&
          (key.includes("/api/partner-profile") ||
            key.includes("/api/shopify") ||
            key.includes("/api/projects")),
        undefined,
        { revalidate: true },
      );
    },
    onError: ({ error }) => {
      toast.error(error.serverError || "Không thể đồng bộ danh mục Shopify.");
    },
  });

  return (
    <div className="space-y-6">
      <ShopifySessionHealthNotice workspaceId={workspaceId} />
      {/* Store Connection Info */}
      <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-semibold text-neutral-900">
                Shopify Store Connection
              </h4>
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                <CheckCircle2 className="h-3 w-3" />
                Installed
              </span>
            </div>
            <p className="text-xs text-neutral-500">
              Cửa hàng được liên kết:{" "}
              <span className="font-mono font-medium text-neutral-800">
                {shopifyStoreId || "Connected Store"}
              </span>
            </p>
          </div>

          <Button
            type="button"
            variant="primary"
            loading={isPending}
            text={isPending ? "Syncing…" : "Sync Catalog Now"}
            icon={<RefreshCw className="h-3.5 w-3.5" />}
            onClick={() => {
              if (workspaceId) {
                execute({ workspaceId });
              }
            }}
            className="flex items-center gap-2 px-4 py-2 text-xs font-medium"
          />
        </div>

        {/* Sync Summary / Details */}
        <div className="mt-4 grid grid-cols-1 gap-3 border-t border-neutral-100 pt-4 sm:grid-cols-2">
          <div className="flex items-center gap-2.5 rounded-lg bg-neutral-50 p-3 text-xs text-neutral-600">
            <ShoppingBag className="h-4 w-4 text-neutral-500" />
            <div>
              <p className="font-medium text-neutral-800">
                Tự động đồng bộ Webhooks
              </p>
              <p className="text-[11px] text-neutral-500">
                12 sự kiện thời gian thực (Sản phẩm, Thị trường, Giảm giá, Đơn
                hàng)
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5 rounded-lg bg-neutral-50 p-3 text-xs text-neutral-600">
            <Globe className="h-4 w-4 text-neutral-500" />
            <div>
              <p className="font-medium text-neutral-800">
                Quy đổi ngoại tệ đa thị trường
              </p>
              <p className="text-[11px] text-neutral-500">
                Tự động áp dụng tỷ giá Shopify Markets & Smart FX Engine
              </p>
            </div>
          </div>
        </div>

        {lastSyncedStats && (
          <div className="mt-3 text-right">
            <span className="text-[11px] text-neutral-400">
              Vừa đồng bộ lúc:{" "}
              {lastSyncedStats.timestamp?.toLocaleTimeString("vi-VN")}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
