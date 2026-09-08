"use client";

import { clientAccessCheck } from "@/lib/client-access-check";
import { usePartnerMessagesCount } from "@/lib/messages/hooks/use-partner-messages-count";
import { getPlanCapabilities } from "@/lib/plan-capabilities";
import { SUBMITTED_LEADS_ENABLED_PROGRAM_IDS } from "@/lib/submitted-leads/constants";
import {
  SubmissionsCountByStatus,
  useBountySubmissionsCount,
} from "@/lib/swr/use-bounty-submissions-count";
import { useFraudGroupCount } from "@/lib/swr/use-fraud-groups-count";
import { usePayoutsCount } from "@/lib/swr/use-payouts-count";
import useProgram from "@/lib/swr/use-program";
import { useProgramSubmittedLeadsCount } from "@/lib/swr/use-program-submitted-leads-count";
import useWorkspace from "@/lib/swr/use-workspace";
import { useKeyboardShortcut, useRouterStuff, useTranslations } from "@dub/ui";
import {
  Bell,
  BookOpen,
  Brush,
  ConnectedDots,
  Crown,
  CubeSettings,
  DiamondTurnRight,
  Flag,
  Folder,
  Gauge6,
  Gear2,
  Gift,
  Globe,
  GridPlus,
  InvoiceDollar,
  Key,
  LifeRing,
  LinesY as LinesYStatic,
  MarketingTarget,
  MoneyBills2,
  Msgs,
  PaperPlane,
  Receipt2,
  ShieldCheck,
  Sliders,
  Sparkle3,
  StackY3,
  Tag,
  Trophy,
  UserCheck,
  UserPlus,
  Users,
  Users6,
  Webhook,
} from "@dub/ui/icons";
import { isWorkspaceBillingTrialActive } from "@dub/utils";
import { DubProduct } from "@prisma/client";
import { Session } from "next-auth";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { ReactNode, useMemo } from "react";
import { toast } from "sonner";
import { mutate } from "swr";
import { DubPartnersPopup } from "./dub-partners-popup";
import { Compass } from "./icons/compass";
import { ConnectedDots4 } from "./icons/connected-dots4";
import { CursorRays } from "./icons/cursor-rays";
import { Hyperlink } from "./icons/hyperlink";
import { LinesY } from "./icons/lines-y";
import { User } from "./icons/user";
import { SidebarNav, SidebarNavAreas, SidebarNavGroups } from "./sidebar-nav";
import { SidebarUsage } from "./sidebar-usage";
import { useProgramApplicationsCount } from "./use-program-applications-count";
import { WorkspaceDropdown } from "./workspace-dropdown";

type SidebarNavData = {
  slug: string;
  pathname: string;
  queryString: string;
  defaultProduct?: "program" | "links";
  session?: Session | null;
  pendingPayoutsCount?: number;
  applicationsCount?: number;
  submittedBountiesCount?: number;
  unreadMessagesCount?: number;
  pendingFraudEventsCount?: number;
  pendingLeadsCount?: number;
  partnerNetworkEnabled?: boolean;
  tAdmin?: (key: string) => string;
  tPartner?: (key: string) => string;
  tCommon?: (key: string) => string;
};

const NAV_GROUPS: SidebarNavGroups<SidebarNavData> = ({
  slug,
  pathname,
  defaultProduct,
}) => {
  const loyaltyGroup = {
    name: "Customer Loyalty",
    description:
      "Retain shoppers and drive repeat purchases with points, VIP tiers, and discount rewards.",
    learnMoreHref: "https://weletic.com",
    icon: Gift,
    href: slug ? `/${slug}/loyalty` : "/loyalty",
    active:
      !!slug &&
      (pathname.startsWith(`/${slug}/loyalty`) ||
        pathname.startsWith(`/${slug}/program/loyalty`)),
  };
  const programGroup = {
    name: "Partner Program",
    description:
      "Kickstart viral product-led growth with powerful, branded referral and affiliate programs.",
    learnMoreHref: "https://dub.co/partners",
    icon: ConnectedDots4,
    href: slug ? `/${slug}/program` : "/program",
    active:
      !!slug &&
      pathname.startsWith(`/${slug}/program`) &&
      !pathname.startsWith(`/${slug}/program/loyalty`),
    popup: DubPartnersPopup,
  };
  const linksGroup = {
    name: "Short Links",
    description:
      "Create, organize, and measure the performance of your short links.",
    learnMoreHref: "https://dub.co/links",
    icon: Compass,
    href: slug ? `/${slug}/links` : "/links",
    active: pathname.startsWith(`/${slug}/links`),
  };

  const reviewsGroup = {
    name: "Reviews",
    description: "Collect and moderate verified product reviews.",
    learnMoreHref: "https://weletic.com",
    icon: Msgs,
    href: slug ? `/${slug}/reviews` : "/reviews",
    active: !!slug && pathname.startsWith(`/${slug}/reviews`),
  };
  const shoppersGroup = {
    name: "Customers",
    description:
      "Shared shopper profiles across loyalty, referrals and reviews.",
    learnMoreHref: "https://weletic.com",
    icon: Users,
    href: slug ? `/${slug}/shoppers` : "/shoppers",
    active: !!slug && pathname.startsWith(`/${slug}/shoppers`),
  };
  return (defaultProduct ?? "links") === "links"
    ? [linksGroup, programGroup, shoppersGroup, loyaltyGroup, reviewsGroup]
    : [programGroup, linksGroup, shoppersGroup, loyaltyGroup, reviewsGroup];
};

const NAV_AREAS: SidebarNavAreas<SidebarNavData> = {
  shoppers: ({ slug }) => ({
    title: "Customers",
    direction: "left",
    content: [
      {
        items: [
          {
            name: "Customer profiles",
            icon: Users,
            href: `/${slug}/shoppers`,
            exact: true,
          },
          { name: "Loyalty", icon: Gift, href: `/${slug}/loyalty` },
          {
            name: "Shared settings",
            icon: CubeSettings,
            href: `/${slug}/shoppers/settings`,
          },
          { name: "Reviews", icon: Msgs, href: `/${slug}/reviews` },
        ],
      },
    ],
  }),
  reviews: ({ slug }) => ({
    title: "Reviews",
    direction: "left",
    content: [
      {
        items: [
          {
            name: "Manage reviews",
            icon: Msgs,
            href: `/${slug}/reviews`,
            exact: true,
          },
          { name: "Review rewards", icon: Gift, href: `/${slug}/loyalty/earn` },
          { name: "Customer profiles", icon: Users, href: `/${slug}/shoppers` },
        ],
      },
    ],
  }),
  // customer loyalty
  loyalty: ({ slug }) => ({
    title: "Customer Loyalty",
    direction: "left",
    content: [
      {
        items: [
          {
            name: "Overview",
            icon: Gauge6,
            href: `/${slug}/loyalty`,
            exact: true,
          },
          { name: "Customer profiles", icon: Users, href: `/${slug}/shoppers` },
        ],
      },
      {
        name: "Points Program",
        items: [
          {
            name: "Ways to Earn",
            icon: Sparkle3,
            href: `/${slug}/loyalty/earn`,
          },
          {
            name: "Ways to Redeem",
            icon: Gift,
            href: `/${slug}/loyalty/rewards`,
          },
        ],
      },
      {
        name: "VIP & Referrals",
        items: [
          {
            name: "VIP Tiers",
            icon: Crown,
            href: `/${slug}/loyalty/tiers`,
          },
          {
            name: "Referral Program",
            icon: UserPlus,
            href: `/${slug}/loyalty/referrals`,
          },
        ],
      },
      {
        name: "Onsite Display",
        items: [
          {
            name: "Launcher & Widget",
            icon: Brush,
            href: `/${slug}/loyalty/branding`,
          },
        ],
      },
      {
        name: "Members & Data",
        items: [
          {
            name: "Shopper Accounts",
            icon: Users,
            href: `/${slug}/loyalty/members`,
          },
          {
            name: "Historical Backfill",
            icon: StackY3,
            href: `/${slug}/loyalty/backfill`,
          },
          {
            name: "Program Settings",
            icon: Gear2,
            href: `/${slug}/loyalty/settings`,
          },
        ],
      },
    ],
  }),
  // partner program
  program: ({
    slug,
    pendingPayoutsCount,
    applicationsCount,
    submittedBountiesCount,
    unreadMessagesCount,
    pendingFraudEventsCount,
    pendingLeadsCount,
    partnerNetworkEnabled,
    tAdmin,
    tPartner,
  }) => ({
    title: tPartner?.("navigation.programs") || "Partner Program",
    direction: "left",
    content: [
      {
        items: [
          {
            name: tAdmin?.("navigation.overview") || "Overview",
            icon: Gauge6,
            href: `/${slug}/program`,
            exact: true,
          },
          {
            name: tAdmin?.("navigation.payouts") || "Payouts",
            icon: MoneyBills2,
            href: `/${slug}/program/payouts?status=pending`,
            badge: pendingPayoutsCount
              ? pendingPayoutsCount > 99
                ? "99+"
                : pendingPayoutsCount
              : undefined,
          },
          {
            name: tPartner?.("navigation.messages") || "Messages",
            icon: Msgs,
            href: `/${slug}/program/messages`,
            badge: unreadMessagesCount
              ? unreadMessagesCount > 99
                ? "99+"
                : unreadMessagesCount
              : undefined,
          },
        ],
      },
      {
        name: tAdmin?.("navigation.partners") || "Partners",
        items: [
          {
            name: tAdmin?.("navigation.allPartners") || "All Partners",
            icon: Users,
            href: `/${slug}/program/partners`,
            isActive: (pathname: string, href: string) =>
              pathname.startsWith(href) &&
              !pathname.startsWith(`${href}/applications`),
          },
          {
            name: tAdmin?.("navigation.groups") || "Groups",
            icon: Users6,
            href: `/${slug}/program/groups`,
          },
          ...(partnerNetworkEnabled
            ? [
                {
                  name:
                    tAdmin?.("navigation.partnerNetwork") || "Partner Network",
                  icon: UserPlus,
                  href: `/${slug}/program/network` as `/${string}`,
                  badge: "New",
                },
              ]
            : []),
          {
            name: tAdmin?.("navigation.applications") || "Applications",
            icon: UserCheck,
            href: `/${slug}/program/partners/applications`,
            badge: applicationsCount
              ? applicationsCount > 99
                ? "99+"
                : applicationsCount
              : undefined,
          },
        ],
      },
      {
        name: tPartner?.("navigation.insights") || "Insights",
        items: [
          {
            name: tAdmin?.("navigation.analytics") || "Analytics",
            icon: LinesYStatic,
            href: `/${slug}/program/analytics`,
            isActive: (pathname: string, href: string) =>
              pathname.startsWith(href) ||
              pathname.startsWith(href.replace("/analytics", "/events")),
          },
          {
            name: tAdmin?.("navigation.customers") || "Customers",
            icon: User,
            href: `/${slug}/program/customers`,
            badge: pendingLeadsCount
              ? pendingLeadsCount > 99
                ? "99+"
                : pendingLeadsCount
              : undefined,
          },
          {
            name: tAdmin?.("navigation.commissions") || "Commissions",
            icon: InvoiceDollar,
            href: `/${slug}/program/commissions`,
          },
          {
            name: tAdmin?.("navigation.riskCenter") || "Risk Center",
            icon: Flag,
            href: `/${slug}/program/risks`,
            badge: pendingFraudEventsCount
              ? pendingFraudEventsCount > 99
                ? "99+"
                : pendingFraudEventsCount
              : undefined,
          },
        ],
      },
      {
        name: tAdmin?.("navigation.engagement") || "Engagement",
        items: [
          {
            name: tAdmin?.("navigation.bounties") || "Bounties",
            icon: Trophy,
            href: `/${slug}/program/bounties`,
            badge: submittedBountiesCount
              ? submittedBountiesCount > 99
                ? "99+"
                : submittedBountiesCount
              : "",
          },
          {
            name: tAdmin?.("navigation.campaigns") || "Email Campaigns",
            icon: PaperPlane,
            href: `/${slug}/program/campaigns` as `/${string}`,
          },
          {
            name: tAdmin?.("navigation.resources") || "Resources",
            icon: LifeRing,
            href: `/${slug}/program/resources`,
          },
        ],
      },
      {
        name: tAdmin?.("navigation.configuration") || "Configuration",
        items: [
          {
            name: tAdmin?.("navigation.rewards") || "Rewards",
            icon: Gift,
            href: `/${slug}/program/groups/default/rewards`,
            arrow: true,
            isActive: () => false,
          },
          {
            name: tAdmin?.("navigation.links") || "Links",
            icon: Sliders,
            href: `/${slug}/program/groups/default/links`,
            arrow: true,
            isActive: () => false,
          },
          {
            name: "Branding",
            icon: Brush,
            arrow: true,
            href: `/${slug}/program/groups/default/branding`,
            isActive: () => false,
          },
        ],
      },
    ],
  }),
  // short links
  links: ({ slug, pathname, queryString }) => ({
    title: "Short Links",
    showNews: true,
    direction: "left",
    content: [
      {
        items: [
          {
            name: "Links",
            icon: Hyperlink,
            href: `/${slug}/links${pathname === `/${slug}/links` ? "" : queryString}`,
            isActive: (pathname: string, href: string) => {
              const basePath = href.split("?")[0];

              // Exact match for the base links page
              if (pathname === basePath) return true;

              // Check if it's a link detail page (path segment after base contains a dot for domain)
              if (pathname.startsWith(basePath + "/")) {
                const nextSegment = pathname
                  .slice(basePath.length + 1)
                  .split("/")[0];
                return nextSegment.includes(".");
              }

              return false;
            },
          },
          {
            name: "Domains",
            icon: Globe,
            href: `/${slug}/links/domains`,
          },
        ],
      },
      {
        name: "Insights",
        items: [
          {
            name: "Analytics",
            icon: LinesY,
            href: `/${slug}/links/analytics${pathname === `/${slug}/links/analytics` ? "" : queryString}`,
          },
          {
            name: "Events",
            icon: CursorRays,
            href: `/${slug}/links/events${pathname === `/${slug}/links/events` ? "" : queryString}`,
          },
          {
            name: "Customers",
            icon: User,
            href: `/${slug}/links/customers`,
          },
        ],
      },
      {
        name: "Library",
        items: [
          {
            name: "Folders",
            icon: Folder,
            href: `/${slug}/links/folders`,
          },
          {
            name: "Tags",
            icon: Tag,
            href: `/${slug}/links/tags`,
          },
          {
            name: "UTM Templates",
            icon: DiamondTurnRight,
            href: `/${slug}/links/utm`,
          },
        ],
      },
    ],
  }),

  // Workspace settings
  workspaceSettings: ({ slug }) => ({
    title: "Settings",
    backHref: `/${slug}`,
    content: [
      {
        name: "Workspace",
        items: [
          {
            name: "General",
            icon: Gear2,
            href: `/${slug}/settings`,
            exact: true,
          },
          {
            name: "Billing",
            icon: Receipt2,
            href: `/${slug}/settings/billing`,
          },
          {
            name: "Domains",
            icon: Globe,
            href: `/${slug}/settings/domains`,
          },
          {
            name: "Members",
            icon: Users6,
            href: `/${slug}/settings/members`,
          },
          {
            name: "Integrations",
            icon: ConnectedDots,
            href: `/${slug}/settings/integrations`,
          },
          {
            name: "Security",
            icon: ShieldCheck,
            href: `/${slug}/settings/security`,
          },
        ],
      },
      {
        name: "Developer",
        items: [
          {
            name: "API Keys",
            icon: Key,
            href: `/${slug}/settings/tokens`,
          },
          {
            name: "Logs",
            icon: StackY3,
            href: `/${slug}/settings/logs`,
          },
          {
            name: "Tracking",
            icon: MarketingTarget,
            href: `/${slug}/settings/tracking`,
          },
          {
            name: "Webhooks",
            icon: Webhook,
            href: `/${slug}/settings/webhooks`,
          },
          {
            name: "OAuth Apps",
            icon: CubeSettings,
            href: `/${slug}/settings/oauth-apps`,
          },
        ],
      },
      {
        name: "Account",
        items: [
          {
            name: "Notifications",
            icon: Bell,
            href: `/${slug}/settings/notifications`,
          },
        ],
      },
    ],
  }),

  // User settings
  userSettings: ({ slug }) => ({
    title: "Settings",
    backHref: `/${slug}`,
    hideSwitcherIcons: true,
    content: [
      {
        name: "Account",
        items: [
          {
            name: "General",
            icon: Gear2,
            href: "/account/settings",
            exact: true,
          },
          {
            name: "Security",
            icon: ShieldCheck,
            href: "/account/settings/security",
          },
          {
            name: "Referrals",
            icon: Gift,
            href: "/account/settings/referrals",
          },
          {
            name: "Notifications",
            icon: Bell,
            href: "/settings/notifications",
            arrow: true,
          },
        ],
      },
    ],
  }),
};

export function AppSidebarNav({
  toolContent,
  newsContent,
}: {
  toolContent?: ReactNode;
  newsContent?: ReactNode;
}) {
  const tAdmin = useTranslations("admin");
  const tPartner = useTranslations("partner");
  const tCommon = useTranslations("common");
  const { slug } = useParams() as { slug?: string };
  const pathname = usePathname();
  const { router, getQueryString } = useRouterStuff();
  const { data: session } = useSession();
  const {
    id: workspaceId,
    plan,
    defaultProduct,
    defaultProgramId,
    trialEndsAt,
    role,
  } = useWorkspace();

  const canSetDefaultProduct = !clientAccessCheck({
    action: "workspaces.write",
    role,
  }).error;

  async function onSetDefaultProduct(product: DubProduct) {
    if (!workspaceId || !slug) {
      return;
    }

    await toast.promise(
      (async () => {
        const response = await fetch(`/api/workspaces/${workspaceId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            defaultProduct: product,
          }),
        });

        if (!response.ok) {
          const { error } = await response.json();
          throw new Error(error.message);
        }

        await mutate(`/api/workspaces/${slug}`);
        router.push(`/${slug}/${product}`);
      })(),
      {
        loading: "Setting default product...",
        success: "Successfully updated your default product!",
        error: (error) => error.message,
      },
    );
  }

  const currentArea = useMemo(() => {
    return pathname.startsWith("/account/settings")
      ? "userSettings"
      : pathname.startsWith(`/${slug}/settings`)
        ? "workspaceSettings"
        : pathname.includes("/program/campaigns/") ||
            pathname.includes("/program/messages/") ||
            pathname.endsWith("/program/payouts/success")
          ? null
          : pathname.startsWith(`/${slug}/loyalty`) ||
              pathname.startsWith(`/${slug}/program/loyalty`)
            ? "loyalty"
            : pathname.startsWith(`/${slug}/reviews`)
              ? "reviews"
              : pathname.startsWith(`/${slug}/shoppers`)
                ? "shoppers"
                : pathname.startsWith(`/${slug}/program`)
                  ? "program"
                  : "links";
  }, [slug, pathname]);

  // Navigate back to the default product when the Escape key is pressed in the workspace settings
  useKeyboardShortcut(
    "Escape",
    () => router.push(`/${slug}/${defaultProduct}`),
    {
      enabled: currentArea === "workspaceSettings",
      priority: 2,
      modal: false,
      sheet: false,
    },
  );

  const { program } = useProgram({
    enabled: Boolean(currentArea === "program" && defaultProgramId),
  });

  const { payoutsCount: pendingPayoutsCount } = usePayoutsCount({
    eligibility: "eligible",
    status: "pending",
    ignoreParams: true,
    enabled: Boolean(currentArea === "program" && defaultProgramId),
  });

  const applicationsCount = useProgramApplicationsCount({
    enabled: Boolean(currentArea === "program" && defaultProgramId),
  });

  const { submissionsCount } = useBountySubmissionsCount<
    SubmissionsCountByStatus[]
  >({
    ignoreParams: true,
    enabled: Boolean(currentArea === "program" && defaultProgramId),
  });

  const submittedBountiesCount =
    submissionsCount?.find(({ status }) => status === "submitted")?.count || 0;

  const { count: unreadMessagesCount } = usePartnerMessagesCount({
    enabled: Boolean(currentArea === "program"),
    query: {
      unread: true,
    },
  });

  const { fraudGroupCount: pendingFraudEventsCount } = useFraudGroupCount<
    number | undefined
  >({
    query: { status: "pending" },
    enabled: Boolean(currentArea === "program" && defaultProgramId),
    ignoreParams: true,
  });

  const { data: pendingLeadsCount } = useProgramSubmittedLeadsCount<number>({
    query: { status: "pending" },
    ignoreParams: true,
    enabled: Boolean(
      currentArea === "program" &&
        defaultProgramId &&
        SUBMITTED_LEADS_ENABLED_PROGRAM_IDS.includes(defaultProgramId),
    ),
  });

  const { canTrackConversions } = getPlanCapabilities(plan);

  const AppBottomContent =
    canSetDefaultProduct &&
    (currentArea === "program" || currentArea === "links") &&
    (defaultProduct ?? "links") !== currentArea ? (
      <button
        type="button"
        onClick={() => onSetDefaultProduct(currentArea)}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-neutral-200/75 px-2.5 py-2 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-200"
      >
        <GridPlus className="size-4" />
        Set as default product tab
      </button>
    ) : canTrackConversions && pathname.startsWith(`/${slug}/links`) ? (
      <Link
        href={`/${slug}/settings/tracking`}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-neutral-200/75 px-2.5 py-2 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-200"
      >
        <BookOpen className="size-4" />
        Set up conversion tracking
      </Link>
    ) : null;

  return (
    <SidebarNav
      groups={NAV_GROUPS}
      areas={NAV_AREAS}
      currentArea={currentArea}
      data={{
        slug: slug || "",
        pathname,
        queryString: getQueryString(undefined, {
          include: ["folderId"],
        }),
        session: session || undefined,
        defaultProduct,
        pendingPayoutsCount: pendingPayoutsCount?.[0]?.count ?? 0,
        applicationsCount,
        submittedBountiesCount,
        unreadMessagesCount,
        pendingFraudEventsCount,
        pendingLeadsCount,
        partnerNetworkEnabled:
          program && program.partnerNetworkEnabledAt !== null,
        tAdmin,
        tPartner,
        tCommon,
      }}
      toolContent={toolContent}
      newsContent={
        plan &&
        (plan === "free" || isWorkspaceBillingTrialActive(trialEndsAt) ? (
          <SidebarUsage />
        ) : (
          newsContent
        ))
      }
      switcher={<WorkspaceDropdown />}
      bottom={<div className="px-3 pb-2">{AppBottomContent}</div>}
    />
  );
}
