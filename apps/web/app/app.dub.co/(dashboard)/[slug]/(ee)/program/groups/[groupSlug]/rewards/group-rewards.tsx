"use client";

import { getPlanCapabilities } from "@/lib/plan-capabilities";
import useGroup from "@/lib/swr/use-group";
import useWorkspace from "@/lib/swr/use-workspace";
import type { GroupProps, RewardProps } from "@/lib/types";
import { DEFAULT_PARTNER_GROUP } from "@/lib/zod/schemas/groups";
import {
  countShopifyRewardOverrides,
  getShopifyRewardLifecycleStatus,
  ShopifyEcommerceRewardConfigSchema,
} from "@/lib/zod/schemas/shopify-ecommerce-reward";
import { useRewardHistorySheet } from "@/ui/activity-logs/reward-history-sheet";
import { useAdvancedUpsellModal } from "@/ui/partners/advanced-upsell-modal";
import { ProgramRewardDescription } from "@/ui/partners/program-reward-description";
import {
  RewardSheet,
  useRewardSheet,
} from "@/ui/partners/rewards/add-edit-reward-sheet";
import { REWARD_EVENT_DESCRIPTIONS } from "@/ui/partners/rewards/reward-event-descriptions";
import { REWARD_EVENT_ICON } from "@/ui/partners/rewards/reward-event-icon";
import {
  Button,
  TimestampTooltip,
  TooltipContent,
  useRouterStuff,
} from "@dub/ui";
import { cn, formatDate } from "@dub/utils";
import { EventType } from "@prisma/client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Shopify } from "@/ui/guides/icons/shopify";
import { ShopifyEcommerceRewardSheet } from "@/ui/partners/rewards/shopify-ecommerce-reward-sheet";

export function GroupRewards() {
  const { group, loading } = useGroup();
  const { searchParams, queryParams } = useRouterStuff();

  const [rewardSheetState, setRewardSheetState] = useState<
    { open: false; rewardId: string | null } | { open: true; rewardId: string }
  >({ open: false, rewardId: null });

  useEffect(() => {
    const rewardId = searchParams.get("rewardId");

    if (rewardId === "shopify") {
      setRewardSheetState({ open: false, rewardId: null });
    } else if (rewardId) {
      setRewardSheetState({ open: true, rewardId });
    } else {
      setRewardSheetState({ open: false, rewardId: null });
    }
  }, [searchParams]);

  const rewards =
    [
      group?.clickReward,
      group?.leadReward,
      group?.saleReward,
      group?.referralReward,
    ].filter(Boolean) ?? [];

  const currentReward = rewardSheetState.rewardId
    ? rewards.find((r) => r?.id === rewardSheetState.rewardId)
    : undefined;
  const isNewReward = rewardSheetState.rewardId?.startsWith("new-");
  const newRewardEvent = isNewReward
    ? (rewardSheetState.rewardId?.replace("new-", "") as EventType)
    : undefined;

  const handleClose = (open: boolean) => {
    if (!open) {
      queryParams({ del: "rewardId" });
    }
    setRewardSheetState((s) => ({ ...s, open }) as typeof s);
  };

  const isShopifyReward = ShopifyEcommerceRewardConfigSchema.safeParse(
    group?.saleReward?.config,
  ).success;
  const shopifyReward = isShopifyReward ? group?.saleReward : null;
  const standardSaleReward = isShopifyReward ? null : group?.saleReward;

  return (
    <div>
      {rewardSheetState.rewardId &&
        (currentReward || isNewReward) &&
        currentReward?.id !== shopifyReward?.id && (
          <RewardSheetWrapper
            reward={currentReward}
            event={newRewardEvent}
            isOpen={rewardSheetState.open}
            setIsOpen={handleClose}
          />
        )}

      {group && (
        <ShopifyEcommerceRewardSheet
          isOpen={
            searchParams.get("rewardId") === "shopify" ||
            searchParams.get("rewardId") === shopifyReward?.id
          }
          setIsOpen={(open) =>
            queryParams(
              open ? { set: { rewardId: "shopify" } } : { del: "rewardId" },
            )
          }
          reward={shopifyReward}
        />
      )}

      <div className="flex flex-col gap-6">
        {loading || !group ? (
          <>
            {Array.from({ length: 5 }).map((_, index) => (
              <RewardSkeleton key={index} />
            ))}
          </>
        ) : (
          <>
            <ShopifyRewardItem
              reward={shopifyReward}
              group={group}
              onOpen={() => queryParams({ set: { rewardId: "shopify" } })}
              disabledReason={
                standardSaleReward
                  ? "Remove the standard sale reward before creating a Shopify eCommerce reward."
                  : undefined
              }
            />
            <RewardItem
              reward={standardSaleReward}
              event="sale"
              group={group}
              disabledReason={
                shopifyReward
                  ? "Remove the Shopify eCommerce reward before creating a standard sale reward."
                  : undefined
              }
            />
            <RewardItem reward={group.leadReward} event="lead" group={group} />
            <RewardItem
              reward={group.clickReward}
              event="click"
              group={group}
            />

            <hr className="border-neutral-200" />

            <RewardItem
              reward={group.referralReward}
              event="referral"
              group={group}
            />
          </>
        )}
      </div>
    </div>
  );
}

const RewardSheetWrapper = ({
  reward,
  event,
  isOpen,
  setIsOpen,
}: {
  reward?: RewardProps | null;
  event?: EventType;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}) => {
  return (
    <RewardSheet
      isOpen={isOpen}
      setIsOpen={setIsOpen}
      event={event || reward?.event || "sale"}
      reward={reward || undefined}
    />
  );
};

const RewardItem = ({
  reward,
  event,
  group,
  disabledReason,
}: {
  reward?: RewardProps | null;
  event: EventType;
  group: GroupProps;
  disabledReason?: string;
}) => {
  const { slug } = useParams();
  const { plan } = useWorkspace();
  const { queryParams } = useRouterStuff();
  const { canCreateReferralReward } = getPlanCapabilities(plan);
  const { advancedUpsellModal, setShowAdvancedUpsellModal } =
    useAdvancedUpsellModal();

  const { RewardSheet, setIsOpen } = useRewardSheet({
    event,
    reward: reward || undefined,
  });

  const {
    loading: activityLogsLoading,
    hasActivityLogs,
    finalActivityLogDate,
    rewardHistorySheet,
    setIsOpen: setHistoryOpen,
  } = useRewardHistorySheet({
    reward: reward ?? null,
  });

  const Icon = REWARD_EVENT_ICON[event];
  const As: any = reward ? Link : "div";

  const lastUpdatedDate = finalActivityLogDate ?? reward?.updatedAt;

  return (
    <>
      {advancedUpsellModal}
      {RewardSheet}
      {rewardHistorySheet}
      <As
        {...(reward
          ? {
              href: `/${slug}/program/groups/${group.slug}/rewards?rewardId=${reward.id}`,
              scroll: false,
            }
          : {})}
        className={cn(
          "flex flex-col gap-4 rounded-lg p-6 transition-all md:flex-row md:items-center",
          reward &&
            "cursor-pointer border border-neutral-200 hover:border-neutral-300",
          !reward && "bg-neutral-50 hover:bg-neutral-100",
        )}
      >
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full border border-neutral-200 bg-white">
          <Icon className="size-4 text-neutral-600" />
        </div>
        <div className="flex flex-1 flex-col justify-between gap-y-4 md:flex-row md:items-center">
          <div className="flex w-full items-center gap-2">
            {reward ? (
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="text-sm font-normal">
                  <ProgramRewardDescription
                    reward={reward}
                    amountClassName="text-blue-600"
                  />
                </div>

                <div className="flex items-center gap-1 text-xs font-medium text-neutral-500">
                  <span>Last updated </span>
                  {!lastUpdatedDate ? (
                    <div className="h-3 w-16 animate-pulse rounded bg-neutral-100" />
                  ) : (
                    <TimestampTooltip
                      timestamp={lastUpdatedDate}
                      side="left"
                      rows={["local", "utc", "unix"]}
                    >
                      <span>
                        {formatDate(lastUpdatedDate, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </span>
                    </TimestampTooltip>
                  )}

                  {activityLogsLoading ? (
                    <div className="ml-1 h-3 w-20 animate-pulse rounded bg-neutral-100" />
                  ) : hasActivityLogs ? (
                    <>
                      <span
                        className="ml-1 size-1 shrink-0 rounded-full bg-neutral-400"
                        aria-hidden
                      />
                      <Button
                        variant="outline"
                        text="View history"
                        className="h-4 w-fit px-1 py-0.5 text-xs font-medium text-neutral-500"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setHistoryOpen(true);
                        }}
                      />
                    </>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="flex flex-col">
                <span className="text-sm font-medium text-neutral-900">
                  {REWARD_EVENT_DESCRIPTIONS[event].title}
                </span>
                <span className="text-sm font-normal text-neutral-500">
                  {REWARD_EVENT_DESCRIPTIONS[event].description}.{" "}
                  <Link
                    href={REWARD_EVENT_DESCRIPTIONS[event].learnMoreHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline decoration-neutral-400 decoration-dotted underline-offset-2 hover:text-neutral-600"
                  >
                    Learn more ↗
                  </Link>
                </span>
              </div>
            )}
          </div>

          {reward ? (
            <Button
              text="Edit"
              variant="secondary"
              className="h-9 w-fit rounded-lg"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                queryParams({
                  set: {
                    rewardId: reward.id,
                  },
                });
              }}
            />
          ) : (
            <div className="flex flex-col-reverse items-center gap-2 md:flex-row">
              {group.slug !== DEFAULT_PARTNER_GROUP.slug &&
                (event !== "referral" || canCreateReferralReward) && (
                  <CopyDefaultRewardButton event={event} />
                )}
              <Button
                text="Create"
                variant="primary"
                className="h-9 w-full rounded-lg md:w-fit"
                disabledTooltip={
                  disabledReason ? (
                    disabledReason
                  ) : event === "referral" && !canCreateReferralReward ? (
                    <TooltipContent
                      title="Referral rewards are only available on the Advanced plan and above."
                      cta="Upgrade to Advanced"
                      onClick={() => setShowAdvancedUpsellModal(true)}
                    />
                  ) : undefined
                }
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (disabledReason) return;
                  setIsOpen(true);
                }}
              />
            </div>
          )}
        </div>
      </As>
    </>
  );
};

const CopyDefaultRewardButton = ({ event }: { event: EventType }) => {
  const { group: defaultGroup } = useGroup({
    groupIdOrSlug: DEFAULT_PARTNER_GROUP.slug,
  });

  const defaultReward = defaultGroup?.[`${event}Reward`];

  const { RewardSheet, setIsOpen } = useRewardSheet({
    event,
    defaultRewardValues: defaultReward ?? undefined,
  });

  return defaultReward ? (
    <>
      {RewardSheet}
      <Button
        text="Duplicate default group"
        variant="secondary"
        className="animate-fade-in h-9 w-full rounded-lg md:w-fit"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsOpen(true);
        }}
      />
    </>
  ) : null;
};

const ShopifyRewardItem = ({
  reward,
  group,
  onOpen,
  disabledReason,
}: {
  reward?: RewardProps | null;
  group: GroupProps;
  onOpen: () => void;
  disabledReason?: string;
}) => {
  const parsedConfig = ShopifyEcommerceRewardConfigSchema.safeParse(
    reward?.config,
  );
  const config = parsedConfig.success ? parsedConfig.data : null;
  const isSplit = config?.customerSegmentMode !== "none";
  const rateSuffix = config?.baseRateType === "flat" ? " flat" : "%";
  const secondaryRate =
    config?.customerSegmentMode === "shopify_segment"
      ? config?.shopifySegment?.rate
      : config?.baseNewRate;
  const secondaryLabel =
    config?.customerSegmentMode === "shopify_segment"
      ? config?.shopifySegment?.name ?? "Segment"
      : "New";
  const overridesCount = config ? countShopifyRewardOverrides(config) : 0;
  const lifecycleStatus = config
    ? getShopifyRewardLifecycleStatus({ activation: config.activation })
    : null;
  const lifecycleLabel =
    lifecycleStatus === "draft"
      ? "Draft"
      : lifecycleStatus === "scheduled"
        ? "Scheduled"
        : lifecycleStatus === "ended"
          ? "Ended"
          : "Active";

  const lastUpdatedDate = reward?.updatedAt;

  return (
    <div
      onClick={disabledReason ? undefined : onOpen}
      className={cn(
        "flex flex-col gap-4 rounded-lg p-6 transition-all md:flex-row md:items-center",
        disabledReason ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        reward
          ? "border border-neutral-200 bg-white hover:border-neutral-300"
          : "bg-neutral-50 hover:bg-neutral-100",
      )}
    >
      <div className="shadow-2xs flex size-10 shrink-0 items-center justify-center rounded-full border border-emerald-200 bg-emerald-50 text-emerald-600">
        <Shopify className="size-5" />
      </div>
      <div className="flex flex-1 flex-col justify-between gap-y-4 md:flex-row md:items-center">
        <div className="flex w-full items-center gap-2">
          {reward ? (
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="text-sm font-normal text-neutral-900">
                <span>Earn </span>
                {isSplit ? (
                  <>
                    <strong className="font-semibold text-blue-600">
                      {config?.baseReturningRate ?? 10}
                      {rateSuffix}
                    </strong>{" "}
                    <span className="text-xs font-medium text-neutral-500">
                      (Returning)
                    </span>
                    {" / "}
                    <strong className="font-semibold text-blue-600">
                      {secondaryRate ?? 20}
                      {rateSuffix}
                    </strong>{" "}
                    <span className="text-xs font-medium text-neutral-500">
                      ({secondaryLabel})
                    </span>
                  </>
                ) : (
                  <strong className="font-semibold text-blue-600">
                    {config?.baseReturningRate ??
                      (reward.amountInPercentage
                        ? Number(reward.amountInPercentage)
                        : 10)}
                    {rateSuffix}
                  </strong>
                )}
                <span> on all products</span>
                {overridesCount > 0 && (
                  <span className="ml-1.5 text-xs font-medium text-neutral-500">
                    • {overridesCount} override{overridesCount > 1 ? "s" : ""}
                  </span>
                )}
                {lifecycleStatus && (
                  <span className="ml-1.5 text-xs font-medium text-neutral-500">
                    • {lifecycleLabel}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1 text-xs font-medium text-neutral-500">
                <span>Last updated </span>
                {lastUpdatedDate && (
                  <TimestampTooltip
                    timestamp={lastUpdatedDate}
                    side="left"
                    rows={["local", "utc", "unix"]}
                  >
                    <span>
                      {formatDate(lastUpdatedDate, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </span>
                  </TimestampTooltip>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col">
              <span className="text-sm font-medium text-neutral-900">
                Shopify eCommerce reward
              </span>
              <span className="text-sm font-normal text-neutral-500">
                Reward affiliates when store orders are generated. Split rates
                by New vs. Returning customers.{" "}
                <span className="underline decoration-neutral-400 decoration-dotted underline-offset-2 hover:text-neutral-600">
                  Learn more ↗
                </span>
              </span>
            </div>
          )}
        </div>

        <Button
          text={reward ? "Edit" : "Create"}
          variant={reward ? "secondary" : "primary"}
          className="h-9 w-full rounded-lg md:w-fit"
          disabledTooltip={disabledReason}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (disabledReason) return;
            onOpen();
          }}
        />
      </div>
    </div>
  );
};

const RewardSkeleton = () => {
  return (
    <div className="flex items-center gap-4 rounded-lg bg-neutral-50 p-6">
      <div className="flex size-10 animate-pulse items-center justify-center rounded-full border border-neutral-200 bg-neutral-100" />
      <div className="flex flex-1 items-center justify-between">
        <div className="h-4 w-64 animate-pulse rounded bg-neutral-100" />
        <div className="h-6 w-24 animate-pulse rounded-full bg-neutral-100" />
      </div>
    </div>
  );
};
