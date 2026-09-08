import { BountySubmissionStatusBadges } from "@/lib/bounty/bounty-submission-status-badges";
import {
  SubmissionsCountByStatus,
  useBountySubmissionsCount,
} from "@/lib/swr/use-bounty-submissions-count";
import useGroups from "@/lib/swr/use-groups";
import usePartners from "@/lib/swr/use-partners";
import useWorkspace from "@/lib/swr/use-workspace";
import { BountyProps, EnrolledPartnerProps } from "@/lib/types";
import { GroupColorCircle } from "@/ui/partners/groups/group-color-circle";
import { PartnerAvatar } from "@/ui/partners/partner-avatar";
import { CircleDotted, useRouterStuff } from "@dub/ui";
import { Users, Users6 } from "@dub/ui/icons";
import { cn, nFormatter } from "@dub/utils";
import { useCallback, useMemo, useState } from "react";
import { useDebounce } from "use-debounce";

export function useBountySubmissionFilters({
  bounty,
}: {
  bounty?: BountyProps;
}) {
  const { searchParamsObj, queryParams } = useRouterStuff();

  const { slug } = useWorkspace();
  const { groups } = useGroups();

  const { submissionsCount } =
    useBountySubmissionsCount<SubmissionsCountByStatus[]>();

  const [selectedFilter, setSelectedFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch] = useDebounce(search, 500);

  const { partners } = usePartnerFilterOptions({
    search: selectedFilter === "partnerId" ? debouncedSearch : "",
    enabled: selectedFilter === "partnerId",
  });

  const filters = useMemo(
    () => [
      {
        key: "partnerId",
        icon: Users,
        label: "Partner",
        shouldFilter: false,
        options:
          partners?.map(({ id, name, image }) => {
            return {
              value: id,
              label: name,
              icon: (
                <PartnerAvatar
                  partner={{ id, name, image }}
                  className="size-4"
                />
              ),
            };
          }) ?? null,
      },
      {
        key: "groupId",
        icon: Users6,
        label: "Group",
        options:
          groups // only show groups that are associated with the bounty
            ?.filter((group) =>
              bounty?.groups && bounty?.groups.length > 0
                ? bounty?.groups.map((g) => g.id).includes(group.id)
                : true,
            )
            .map((group) => {
              return {
                value: group.id,
                label: group.name,
                icon: <GroupColorCircle group={group} />,
              };
            }) ?? null,
      },
      {
        key: "status",
        icon: CircleDotted,
        label: "Status",
        options: submissionsCount
          ? submissionsCount.map(({ status, count }) => {
              const {
                label,
                icon: Icon,
                iconClassName,
              } = BountySubmissionStatusBadges[status];
              return {
                value: status,
                label,
                icon: (
                  <Icon
                    className={cn("size-4 bg-transparent", iconClassName)}
                  />
                ),
                right: nFormatter(count, {
                  full: true,
                }),
              };
            })
          : null,
      },
    ],
    [groups, bounty, submissionsCount, partners],
  );

  const activeFilters = useMemo(() => {
    const { status, groupId, partnerId } = searchParamsObj;

    return [
      ...(status ? [{ key: "status", value: status }] : []),
      ...(groupId ? [{ key: "groupId", value: groupId }] : []),
      ...(partnerId ? [{ key: "partnerId", value: partnerId }] : []),
    ];
  }, [searchParamsObj]);

  const onSelect = useCallback(
    (key: string, value: any) =>
      queryParams({
        set: {
          [key]: value,
        },
        del: "page",
      }),
    [queryParams],
  );

  const onRemove = useCallback(
    (key: string) =>
      queryParams({
        del: [key, "page"],
      }),
    [queryParams],
  );

  const onRemoveAll = useCallback(
    () =>
      queryParams({
        del: ["status", "groupId", "partnerId"],
      }),
    [queryParams],
  );

  const onOpenFilter = useCallback(
    (key: string | null) => setSelectedFilter(key),
    [],
  );

  const isFiltered = useMemo(
    () => activeFilters.length > 0 || searchParamsObj.search,
    [activeFilters, searchParamsObj.search],
  );

  return {
    filters,
    activeFilters,
    onSelect,
    onRemove,
    onRemoveAll,
    onOpenFilter,
    isFiltered,
    setSearch,
    setSelectedFilter,
  };
}

function usePartnerFilterOptions({
  search,
  enabled = false,
}: {
  search: string;
  enabled?: boolean;
}) {
  const { searchParamsObj } = useRouterStuff();

  const activePartnerId = searchParamsObj.partnerId;

  const { partners, loading: partnersLoading } = usePartners({
    query: { search },
    enabled,
  });

  const { partners: selectedPartners, loading: selectedLoading } = usePartners({
    query: {
      partnerIds: activePartnerId ? [activePartnerId] : undefined,
    },
    enabled: !!activePartnerId,
  });

  const result = useMemo(() => {
    if (!enabled && !activePartnerId) return null;
    if (enabled && partnersLoading) return null;
    if (activePartnerId && selectedLoading) return null;

    return partnersLoading ||
      // Consider partners loading if we can't find the currently filtered partner
      (activePartnerId &&
        ![...(selectedPartners ?? []), ...(partners ?? [])].some(
          (p) => p.id === activePartnerId,
        ))
      ? null
      : ([
          ...(partners ?? []),
          // Add selected partner to list if not already in partners
          ...(selectedPartners
            ?.filter((st) => !partners?.some((t) => t.id === st.id))
            ?.map((st) => ({ ...st, hideDuringSearch: true })) ?? []),
        ] as (EnrolledPartnerProps & { hideDuringSearch?: boolean })[]);
  }, [
    enabled,
    partnersLoading,
    selectedLoading,
    partners,
    selectedPartners,
    activePartnerId,
  ]);

  return { partners: result };
}
