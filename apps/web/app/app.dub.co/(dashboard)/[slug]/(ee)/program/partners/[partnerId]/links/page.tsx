"use client";

import { usePartnerReferral } from "@/lib/partner-referrals/hooks/use-partner-referral";
import { constructPartnerReferralLink } from "@/lib/partner-referrals/utils";
import { constructPartnerLink } from "@/lib/partners/construct-partner-link";
import { mutatePartner } from "@/lib/swr/mutate";
import useDiscountCodes from "@/lib/swr/use-discount-codes";
import useGroup from "@/lib/swr/use-group";
import usePartner from "@/lib/swr/use-partner";
import useProgram from "@/lib/swr/use-program";
import useWorkspace from "@/lib/swr/use-workspace";
import {
  DiscountCodeProps,
  EnrolledPartnerCompositeProps,
  EnrolledPartnerExtendedProps,
  EnrolledPartnerProps,
} from "@/lib/types";
import { useAddDiscountCodeModal } from "@/ui/modals/add-discount-code-modal";
import { useAddPartnerLinkModal } from "@/ui/modals/add-partner-link-modal";
import { DeleteDiscountCodeModal } from "@/ui/modals/delete-discount-code-modal";
import { DiscountCodeBadge } from "@/ui/partners/discounts/discount-code-badge";
import { ButtonLink } from "@/ui/placeholders/button-link";
import {
  Button,
  CopyButton,
  LoadingSpinner,
  Table,
  Tag,
  Tooltip,
  TooltipContent,
  useTable,
} from "@dub/ui";
import { BoxArchive, Trash } from "@dub/ui/icons";
import {
  cn,
  currencyFormatter,
  formatDateTime,
  getPrettyUrl,
  nFormatter,
  timeAgo,
} from "@dub/utils";
import { DiscountProvider } from "@prisma/client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

export default function ProgramPartnerLinksPage() {
  const { partnerId } = useParams() as { partnerId: string };
  const { partner, error } = usePartner<EnrolledPartnerCompositeProps>({
    partnerId,
    includeComposite: true,
  });

  return partner ? (
    <div className="grid min-w-0 gap-4">
      <PartnerLinks partner={partner} />
      <PartnerDiscountCodes partner={partner} />
      <PartnerReferralLink partner={partner} />
    </div>
  ) : (
    <div className="flex justify-center py-16">
      {error ? (
        <span className="text-content-subtle text-sm">
          Failed to load partner links
        </span>
      ) : (
        <LoadingSpinner />
      )}
    </div>
  );
}

const PartnerLinks = ({
  partner,
}: {
  partner: EnrolledPartnerProps & { group?: any };
}) => {
  const { slug } = useWorkspace();

  const { group: fetchedGroup } = useGroup({
    groupIdOrSlug: partner.groupId ?? undefined,
  });
  const group = partner.group ?? fetchedGroup;

  const { AddPartnerLinkModal, setShowAddPartnerLinkModal } =
    useAddPartnerLinkModal({
      partner,
    });

  const table = useTable({
    data: partner.links || [],
    columns: [
      {
        id: "shortLink",
        header: "Link",
        meta: {
          disableTruncate: true,
        },
        cell: ({ row }) => {
          const partnerLink = constructPartnerLink({
            group: group ?? undefined,
            link: row.original,
          });
          return (
            <div className="flex items-center gap-3">
              <Link
                href={`/${slug}/links/${row.original.domain}/${row.original.key}`}
                target="_blank"
                className="cursor-alias font-medium text-black decoration-dotted hover:underline"
              >
                {getPrettyUrl(partnerLink)}
              </Link>
              <CopyButton value={partnerLink} className="p-0.5" />
            </div>
          );
        },
      },
      {
        header: "Clicks",
        size: 1,
        minSize: 1,
        cell: ({ row }) => (
          <Link
            href={`/${slug}/events?event=clicks&interval=all&domain=${row.original.domain}&key=${row.original.key}`}
            target="_blank"
            className="block w-full cursor-alias decoration-dotted hover:underline"
          >
            {nFormatter(row.original.clicks)}
          </Link>
        ),
      },
      {
        header: "Leads",
        size: 1,
        minSize: 1,
        cell: ({ row }) => (
          <Link
            href={`/${slug}/events?event=leads&interval=all&domain=${row.original.domain}&key=${row.original.key}`}
            target="_blank"
            className="block w-full cursor-alias decoration-dotted hover:underline"
          >
            {nFormatter(row.original.leads)}
          </Link>
        ),
      },
      {
        header: "Conversions",
        size: 1,
        minSize: 1,
        cell: ({ row }) => (
          <Link
            href={`/${slug}/events?event=sales&interval=all&domain=${row.original.domain}&key=${row.original.key}`}
            target="_blank"
            className="block w-full cursor-alias decoration-dotted hover:underline"
          >
            {nFormatter(row.original.conversions)}
          </Link>
        ),
      },
      {
        header: "Revenue",
        accessorFn: (d) =>
          currencyFormatter(d.saleAmount, {
            trailingZeroDisplay: "stripIfInteger",
          }),
        size: 1,
        minSize: 1,
        cell: ({ row }) => (
          <Link
            href={`/${slug}/events?event=sales&interval=all&domain=${row.original.domain}&key=${row.original.key}`}
            target="_blank"
            className="block w-full cursor-alias decoration-dotted hover:underline"
          >
            {currencyFormatter(row.original.saleAmount, {
              trailingZeroDisplay: "stripIfInteger",
            })}
          </Link>
        ),
      },
    ],
    resourceName: (p) => `link${p ? "s" : ""}`,
    thClassName: (id) =>
      cn(id === "total" && "[&>div]:justify-end", "border-l-0"),
    tdClassName: (id) => cn(id === "total" && "text-right", "border-l-0"),
    className: "[&_tr:last-child>td]:border-b-transparent",
    containerClassName: "w-full max-w-full overflow-hidden",
    scrollWrapperClassName: "min-h-[40px] max-w-full",
  } as any);

  return (
    <>
      <div className="flex items-end justify-between gap-4">
        <h2 className="text-content-emphasis text-lg font-semibold">
          Referral links
        </h2>
        <Button
          variant="secondary"
          text="Create link"
          className="h-8 w-fit rounded-lg px-3 py-2 font-medium"
          onClick={() => setShowAddPartnerLinkModal(true)}
        />
      </div>
      <Table {...table} />
      <AddPartnerLinkModal />
    </>
  );
};

const PartnerReferralLink = ({
  partner,
}: {
  partner: EnrolledPartnerProps & { referral?: any };
}) => {
  const { slug } = useWorkspace();
  const router = useRouter();
  const {
    program,
    loading: loadingProgram,
    error: errorProgram,
  } = useProgram();
  const {
    referral: fetchedReferral,
    loading: loadingReferral,
    error: referralError,
  } = usePartnerReferral({
    partnerId: partner.id,
  });

  const referral = partner.referral ?? fetchedReferral;
  const isReferralLoading =
    partner.referral === undefined ? loadingReferral || loadingProgram : false;

  const referralLink = constructPartnerReferralLink({
    partner,
    program,
  });

  const data = useMemo(() => {
    if (!referralLink || !referral?.stats) {
      return [];
    }

    return [
      {
        link: referralLink,
        totalPartners: referral.stats.totalPartners,
        totalConversions: referral.stats.totalConversions,
        totalSaleAmount: referral.stats.totalSaleAmount,
      },
    ];
  }, [referralLink, referral]);

  const referredPartnersUrl = `/${slug}/program/partners?referredByPartnerId=${partner.id}`;

  const table = useTable({
    data,
    columns: [
      {
        id: "link",
        header: "Link",
        cell: ({ row }) => (
          <div className="flex items-center gap-3">
            <span className="font-medium text-black">
              {getPrettyUrl(row.original.link)}
            </span>
            <CopyButton value={row.original.link} className="p-0.5" />
          </div>
        ),
      },
      {
        header: "Partners",
        size: 1,
        minSize: 1,
        cell: ({ row }) => nFormatter(row.original.totalPartners),
      },
      {
        header: "Conversions",
        size: 1,
        minSize: 1,
        cell: ({ row }) => nFormatter(row.original.totalConversions),
      },
      {
        header: "Revenue",
        size: 1,
        minSize: 1,
        cell: ({ row }) =>
          currencyFormatter(row.original.totalSaleAmount, {
            trailingZeroDisplay: "stripIfInteger",
          }),
      },
    ],
    onRowClick: (_row, e) => {
      if (e.metaKey || e.ctrlKey) window.open(referredPartnersUrl, "_blank");
      else router.push(referredPartnersUrl);
    },
    onRowAuxClick: () => window.open(referredPartnersUrl, "_blank"),
    rowProps: () => ({
      onPointerEnter: () => router.prefetch(referredPartnersUrl),
    }),
    resourceName: (p) => `link${p ? "s" : ""}`,
    thClassName: (id) =>
      cn(id === "total" && "[&>div]:justify-end", "border-l-0"),
    tdClassName: (id) => cn(id === "total" && "text-right", "border-l-0"),
    className: "[&_tr:last-child>td]:border-b-transparent",
    scrollWrapperClassName: "min-h-[40px]",
    loading: isReferralLoading,
    error:
      referralError || errorProgram
        ? "Failed to load partner referral data"
        : undefined,
  });

  if (!partner?.referralRewardId) {
    return null;
  }

  return (
    <>
      <h2 className="text-content-emphasis text-lg font-semibold">
        Partner referral link
      </h2>
      <Table {...table} />
    </>
  );
};

const PartnerDiscountCodes = ({
  partner,
}: {
  partner: EnrolledPartnerExtendedProps & {
    discountCodes?: DiscountCodeProps[];
    group?: any;
  };
}) => {
  const { slug, stripeConnectId, shopifyStoreId } = useWorkspace();
  const { group: fetchedGroup } = useGroup({
    groupIdOrSlug: partner.groupId ?? undefined,
  });
  const group = partner.group ?? fetchedGroup;

  const [selectedDiscountCode, setSelectedDiscountCode] =
    useState<DiscountCodeProps | null>(null);

  const [showDeleteDiscountCodeModal, setShowDeleteDiscountCodeModal] =
    useState(false);

  const [viewTab, setViewTab] = useState<"active" | "archived">("active");

  const [isRestoring, setIsRestoring] = useState<string | null>(null);

  const {
    discountCodes: fetchedDiscountCodes,
    loading,
    error,
    mutate: mutateDiscountCodes,
  } = useDiscountCodes({
    partnerId: partner.id || null,
    query: { status: "all" },
  });

  const rawCodes = fetchedDiscountCodes ?? partner.discountCodes;
  const activeDiscountCodes = useMemo(
    () => (rawCodes || []).filter((d) => !d.disabledAt),
    [rawCodes],
  );
  const archivedDiscountCodes = useMemo(
    () => (rawCodes || []).filter((d) => !!d.disabledAt),
    [rawCodes],
  );

  const isCodesLoading = rawCodes === undefined && loading;

  const { AddDiscountCodeModal, setShowAddDiscountCodeModal } =
    useAddDiscountCodeModal({
      partner,
      activeDiscountCodes,
    });

  const activeTable = useTable({
    data: activeDiscountCodes,
    columns: [
      {
        id: "code",
        header: "Code",
        cell: ({ row }) => (
          <DiscountCodeBadge
            code={row.original.code}
            disabledAt={row.original.disabledAt}
          />
        ),
      },
      {
        id: "shortLink",
        header: "Link",
        cell: ({ row }) => {
          const link = partner.links?.find((l) => l.id === row.original.linkId);
          return link ? (
            <Link
              href={`/${slug}/links/${link.domain}/${link.key}`}
              target="_blank"
              className="cursor-alias font-medium text-black decoration-dotted hover:underline"
            >
              {getPrettyUrl(link.shortLink)}
            </Link>
          ) : (
            <span className="text-neutral-500">Link not found</span>
          );
        },
      },
      {
        id: "menu",
        enableHiding: false,
        minSize: 28,
        size: 28,
        maxSize: 28,
        cell: ({ row }) => (
          <Button
            icon={<Trash className="size-3.5 shrink-0 text-neutral-600" />}
            variant="outline"
            className="size-8 whitespace-nowrap"
            onClick={() => {
              setSelectedDiscountCode(row.original);
              setShowDeleteDiscountCodeModal(true);
            }}
          />
        ),
      },
    ],
    resourceName: (p) => `discount code${p ? "s" : ""}`,
    thClassName: (id) =>
      cn(id === "total" && "[&>div]:justify-end", "border-l-0"),
    tdClassName: (id) => cn(id === "total" && "text-right", "border-l-0"),
    className: "[&_tr:last-child>td]:border-b-transparent",
    scrollWrapperClassName: "min-h-[40px]",
    loading: isCodesLoading,
    error: error ? "Failed to load discount codes" : undefined,
  } as any);

  const archivedTable = useTable({
    data: archivedDiscountCodes,
    columns: [
      {
        id: "code",
        header: "Code",
        cell: ({ row }) => (
          <DiscountCodeBadge
            code={row.original.code}
            disabledAt={row.original.disabledAt}
            disabledTooltip="This discount code was disabled/archived and is retained for historical audit."
          />
        ),
      },
      {
        id: "shortLink",
        header: "Link",
        cell: ({ row }) => {
          const link = partner.links?.find((l) => l.id === row.original.linkId);
          return link ? (
            <Link
              href={`/${slug}/links/${link.domain}/${link.key}`}
              target="_blank"
              className="cursor-alias font-medium text-neutral-600 decoration-dotted hover:underline"
            >
              {getPrettyUrl(link.shortLink)}
            </Link>
          ) : (
            <span className="text-neutral-400">Unassigned / unlinked</span>
          );
        },
      },
      {
        id: "disabledAt",
        header: "Disabled",
        cell: ({ row }) => {
          if (!row.original.disabledAt)
            return <span className="text-neutral-400">-</span>;
          const disabledDate = new Date(row.original.disabledAt);
          return (
            <Tooltip
              content={
                <div className="p-1 text-xs">
                  {formatDateTime(disabledDate, {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                    hour: "numeric",
                    minute: "numeric",
                  })}
                </div>
              }
            >
              <span className="cursor-help text-xs text-neutral-500 underline decoration-dotted underline-offset-2">
                {timeAgo(disabledDate, { withAgo: true })}
              </span>
            </Tooltip>
          );
        },
      },
      {
        id: "actions",
        enableHiding: false,
        minSize: 90,
        size: 90,
        maxSize: 90,
        cell: ({ row }) => {
          const availableLink =
            partner.links?.find(
              (l) =>
                l.id === row.original.linkId &&
                !activeDiscountCodes.some((c) => c.linkId === l.id),
            ) || availableLinks[0];

          return (
            <Button
              variant="outline"
              className="h-7 w-fit gap-1.5 px-2.5 text-xs font-medium"
              text="Restore"
              disabled={!availableLink || isRestoring === row.original.id}
              loading={isRestoring === row.original.id}
              onClick={async () => {
                if (!availableLink) {
                  toast.error(
                    "Please add a new referral link before restoring this discount code.",
                  );
                  return;
                }
                setIsRestoring(row.original.id);
                try {
                  const res = await fetch(
                    `/api/discount-codes?workspaceId=${slug}`,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        partnerId: partner.id,
                        linkId: availableLink.id,
                        code: row.original.code,
                      }),
                    },
                  );
                  if (!res.ok) {
                    const err = await res.json();
                    throw new Error(
                      err.error?.message || "Failed to restore discount code",
                    );
                  }
                  await mutateDiscountCodes();
                  await mutatePartner(partner.id);
                  toast.success(
                    `Discount code "${row.original.code}" restored successfully`,
                  );
                  setViewTab("active");
                } catch (e: any) {
                  toast.error(e.message || "Failed to restore discount code");
                } finally {
                  setIsRestoring(null);
                }
              }}
            />
          );
        },
      },
    ],
    resourceName: (p) => `archived discount code${p ? "s" : ""}`,
    thClassName: (id) =>
      cn(id === "total" && "[&>div]:justify-end", "border-l-0"),
    tdClassName: (id) => cn(id === "total" && "text-right", "border-l-0"),
    className: "[&_tr:last-child>td]:border-b-transparent",
    scrollWrapperClassName: "min-h-[40px]",
    loading: isCodesLoading,
    error: error ? "Failed to load discount codes" : undefined,
  } as any);

  const availableLinks = useMemo(() => {
    return (partner.links || []).filter(
      (link) => !activeDiscountCodes.some((c) => c.linkId === link.id),
    );
  }, [partner.links, activeDiscountCodes]);

  const disabledReason = useMemo(() => {
    if (!partner.discount) {
      return "No discount assigned to this partner group. Please add a discount before you can create a discount code.";
    }

    if (
      partner.discount.provider === DiscountProvider.stripe &&
      !stripeConnectId
    ) {
      return (
        <TooltipContent
          title="Your workspace isn't connected to Stripe yet. Please install the Dub Stripe app in settings to create discount codes."
          cta="Install Stripe app"
          href={`/${slug}/settings/integrations/stripe`}
          target="_blank"
        />
      );
    }

    if (
      partner.discount.provider === DiscountProvider.shopify &&
      !shopifyStoreId
    ) {
      return (
        <TooltipContent
          title="Your workspace isn't connected to Shopify yet. Please install the Dub Shopify app in settings to create discount codes."
          cta="Install Shopify app"
          href={`/${slug}/settings/integrations/shopify`}
          target="_blank"
        />
      );
    }

    if (!partner.links || partner.links.length === 0) {
      return "No links assigned to this partner group. Please add a link before you can create a discount code.";
    }

    if (availableLinks.length === 0) {
      return "All links have a discount code assigned to them. Please add a new link before you can create a discount code.";
    }

    return undefined;
  }, [
    partner.discount,
    partner.links,
    availableLinks.length,
    stripeConnectId,
    shopifyStoreId,
    slug,
  ]);

  const groupDiscount = group?.discount ?? partner.discount;

  const discountCodeEmptyState = groupDiscount
    ? {
        description:
          "Great for short-form content, podcasts and more. Works alongside link-based discounts.",
        buttonText: "Learn more",
        buttonHref:
          "https://dub.co/help/article/dual-sided-incentives#option-2-using-stripe-promo-codes-no-code-required",
      }
    : {
        description:
          "You need to create a group discount for this partner before you can create a discount code.",
        buttonText: "Create group discount",
        buttonHref: group?.slug
          ? `/${slug}/program/groups/${group.slug}/discounts`
          : `/${slug}/program/groups`,
      };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h2 className="text-content-emphasis text-lg font-semibold">
            Discount codes
          </h2>
          <div className="inline-flex rounded-lg bg-neutral-100 p-0.5">
            <button
              type="button"
              onClick={() => setViewTab("active")}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-150",
                viewTab === "active"
                  ? "bg-white text-neutral-900 shadow-sm"
                  : "text-neutral-600 hover:text-neutral-900",
              )}
            >
              Active ({activeDiscountCodes.length})
            </button>
            <button
              type="button"
              onClick={() => setViewTab("archived")}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-150",
                viewTab === "archived"
                  ? "bg-white text-neutral-900 shadow-sm"
                  : "text-neutral-600 hover:text-neutral-900",
              )}
            >
              Archived ({archivedDiscountCodes.length})
            </button>
          </div>
        </div>
        <Button
          variant="secondary"
          text="Create code"
          className="h-8 w-fit rounded-lg px-3 py-2 font-medium"
          onClick={() => setShowAddDiscountCodeModal(true)}
          disabled={!!disabledReason}
          disabledTooltip={disabledReason}
        />
      </div>

      {isCodesLoading ? (
        <div className="flex justify-center py-16">
          <LoadingSpinner />
        </div>
      ) : error ? (
        <div className="flex justify-center py-16">
          <span className="text-content-subtle text-sm">
            Failed to load discount codes
          </span>
        </div>
      ) : viewTab === "active" ? (
        activeDiscountCodes.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 py-6">
            <div className="flex max-w-sm flex-col items-center gap-2 text-center">
              <Tag className="mb-2 size-6 text-neutral-900" />
              <h3 className="text-content-emphasis text-sm font-semibold leading-5">
                No discount codes created
              </h3>
              <p className="text-content-subtle -mt-1 text-sm font-medium leading-5">
                {discountCodeEmptyState.description}
              </p>
              {discountCodeEmptyState.buttonHref && (
                <ButtonLink
                  href={discountCodeEmptyState.buttonHref}
                  target={
                    discountCodeEmptyState.buttonHref.startsWith("https")
                      ? "_blank"
                      : undefined
                  }
                  variant="secondary"
                  className="mt-2 h-7 rounded-md px-3 text-sm font-medium"
                >
                  {discountCodeEmptyState.buttonText}
                </ButtonLink>
              )}
            </div>
          </div>
        ) : (
          <Table {...activeTable} />
        )
      ) : archivedDiscountCodes.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 py-8">
          <div className="flex max-w-sm flex-col items-center gap-2 text-center">
            <BoxArchive className="mb-2 size-6 text-neutral-400" />
            <h3 className="text-content-emphasis text-sm font-semibold leading-5">
              No archived discount codes
            </h3>
            <p className="text-content-subtle -mt-1 text-sm font-medium leading-5">
              Disabled or deleted discount codes will appear here for historical
              audit and reporting.
            </p>
          </div>
        </div>
      ) : (
        <Table {...archivedTable} />
      )}

      <AddDiscountCodeModal />

      {selectedDiscountCode && (
        <DeleteDiscountCodeModal
          showModal={showDeleteDiscountCodeModal}
          setShowModal={setShowDeleteDiscountCodeModal}
          discountCode={selectedDiscountCode}
        />
      )}
    </>
  );
};
