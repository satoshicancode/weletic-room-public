import useCommissionsCount from "@/lib/swr/use-commissions-count";
import useCustomers from "@/lib/swr/use-customers";
import useGroups from "@/lib/swr/use-groups";
import { usePartnerTags } from "@/lib/swr/use-partner-tags";
import usePartners from "@/lib/swr/use-partners";
import { CustomerProps, EnrolledPartnerProps } from "@/lib/types";
import { CustomerAvatar } from "@/ui/customers/customer-avatar";
import { CommissionTypeIcon } from "@/ui/partners/comission-type-icon";
import { CommissionStatusBadges } from "@/ui/partners/commission-status-badges";
import { GroupColorCircle } from "@/ui/partners/groups/group-color-circle";
import { PartnerAvatar } from "@/ui/partners/partner-avatar";
import { CircleDotted, useRouterStuff } from "@dub/ui";
import { Sliders, Tag, User, Users, Users6 } from "@dub/ui/icons";
import {
  capitalize,
  cn,
  FilterOperator,
  nFormatter,
  parseFilterValue,
} from "@dub/utils";
import { CommissionType } from "@prisma/client";
import { useCallback, useMemo, useState } from "react";
import { useDebounce } from "use-debounce";

export function useCommissionFilters() {
  const { commissionsCount } = useCommissionsCount({ exclude: ["status"] });
  const { searchParamsObj, queryParams } = useRouterStuff();

  const [selectedFilter, setSelectedFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch] = useDebounce(search, 500);

  const { partners } = usePartnerFilterOptions({
    search: selectedFilter === "partnerId" ? debouncedSearch : "",
    enabled: selectedFilter === "partnerId",
  });

  const { customers } = useCustomerFilterOptions({
    search: selectedFilter === "customerId" ? debouncedSearch : "",
    enabled: selectedFilter === "customerId",
  });

  const { groups } = useGroups();

  const activePartnerTagIds = useMemo(
    () =>
      searchParamsObj.partnerTagId
        ? searchParamsObj.partnerTagId
            .replace(/^-/, "")
            .split(",")
            .filter(Boolean)
        : undefined,
    [searchParamsObj.partnerTagId],
  );

  const isPartnerTagFilterOpen = selectedFilter === "partnerTagId";
  const { partnerTags, isLoading: partnerTagsLoading } = usePartnerTags({
    enabled: isPartnerTagFilterOpen,
  });
  const {
    partnerTags: selectedPartnerTags,
    isLoading: selectedPartnerTagsLoading,
  } = usePartnerTags({
    query: { ids: activePartnerTagIds },
    enabled: !!activePartnerTagIds?.length,
  });

  const mergedPartnerTags = useMemo(() => {
    if (!isPartnerTagFilterOpen && !activePartnerTagIds?.length) return null;
    if (isPartnerTagFilterOpen && partnerTagsLoading) return null;
    if (activePartnerTagIds?.length && selectedPartnerTagsLoading) return null;
    if (!partnerTags && !selectedPartnerTags) return null;
    const baseIds = new Set((partnerTags ?? []).map((t) => t.id));
    return [
      ...(partnerTags ?? []),
      ...(selectedPartnerTags ?? []).filter((t) => !baseIds.has(t.id)),
    ];
  }, [
    isPartnerTagFilterOpen,
    partnerTags,
    selectedPartnerTags,
    partnerTagsLoading,
    selectedPartnerTagsLoading,
    activePartnerTagIds,
  ]);

  const filters = useMemo(
    () => [
      {
        key: "customerId",
        icon: User,
        label: "Customer",
        shouldFilter: false,
        options:
          customers?.map((customer) => {
            return {
              value: customer.id,
              label: customer.email ?? customer.name ?? customer.id,
              icon: <CustomerAvatar customer={customer} className="size-4" />,
            };
          }) ?? null,
      },
      {
        key: "partnerId",
        icon: Users,
        label: "Partner",
        shouldFilter: false,
        options:
          partners?.map((partner) => {
            return {
              value: partner.id,
              label: partner.name,
              icon: <PartnerAvatar partner={partner} className="size-4" />,
            };
          }) ?? null,
      },
      {
        key: "groupId",
        icon: Users6,
        label: "Partner Group",
        options:
          groups?.map((group) => {
            return {
              value: group.id,
              label: group.name,
              icon: <GroupColorCircle group={group} />,
            };
          }) ?? null,
      },
      {
        key: "partnerTagId",
        icon: Tag,
        label: "Partner Tag",
        options:
          mergedPartnerTags?.map((tag) => ({
            value: tag.id,
            label: tag.name,
          })) ?? null,
      },
      {
        key: "type",
        icon: Sliders,
        label: "Type",
        options: Object.values(CommissionType).map((type) => ({
          value: type,
          label: capitalize(type) as string,
          icon: <CommissionTypeIcon type={type} />,
        })),
      },
      {
        key: "status",
        icon: CircleDotted,
        label: "Status",
        singleSelect: true,
        options: Object.entries(CommissionStatusBadges).map(
          ([value, { label }]) => {
            const Icon = CommissionStatusBadges[value].icon;
            return {
              value,
              label,
              icon: (
                <Icon
                  className={cn(
                    CommissionStatusBadges[value].className,
                    "size-4 bg-transparent",
                  )}
                />
              ),
              right: commissionsCount?.[value]?.count
                ? nFormatter(commissionsCount[value].count, {
                    full: true,
                  })
                : undefined,
            };
          },
        ),
      },
    ],
    [commissionsCount, partners, customers, groups, mergedPartnerTags],
  );

  const activeFilters = useMemo(() => {
    const result: {
      key: string;
      operator: FilterOperator;
      values: string[];
    }[] = [];
    const keys = [
      "customerId",
      "partnerId",
      "status",
      "type",
      "payoutId",
      "groupId",
      "partnerTagId",
    ] as const;
    for (const key of keys) {
      const raw = searchParamsObj[key];
      if (!raw) continue;
      const parsed = parseFilterValue(raw);
      if (parsed)
        result.push({ key, operator: parsed.operator, values: parsed.values });
    }
    return result;
  }, [searchParamsObj]);

  const onSelect = useCallback(
    (key: string, value: string) => {
      const currentParam = searchParamsObj[key];
      const filterDef = filters.find((f) => f.key === key);
      const isSingleSelect = filterDef?.singleSelect;

      if (!currentParam || isSingleSelect) {
        queryParams({ set: { [key]: value }, del: "page" });
        return;
      }
      const parsed = parseFilterValue(currentParam);
      if (parsed && !parsed.values.includes(value)) {
        const newValues = [...parsed.values, value];
        const newParam = parsed.operator.includes("NOT")
          ? `-${newValues.join(",")}`
          : newValues.join(",");
        queryParams({ set: { [key]: newParam }, del: "page" });
      }
    },
    [searchParamsObj, queryParams, filters],
  );

  const onRemove = useCallback(
    (key: string, value: string) => {
      const currentParam = searchParamsObj[key];
      if (!currentParam) return;
      const parsed = parseFilterValue(currentParam);
      if (!parsed) {
        queryParams({ del: [key, "page"] });
        return;
      }
      const newValues = parsed.values.filter((v) => v !== value);
      if (newValues.length === 0) {
        queryParams({ del: [key, "page"] });
      } else {
        const newParam = parsed.operator.includes("NOT")
          ? `-${newValues.join(",")}`
          : newValues.join(",");
        queryParams({ set: { [key]: newParam }, del: "page" });
      }
    },
    [searchParamsObj, queryParams],
  );

  const onRemoveFilter = useCallback(
    (key: string) => queryParams({ del: [key, "page"] }),
    [queryParams],
  );

  const onRemoveAll = useCallback(
    () =>
      queryParams({
        del: [
          "status",
          "partnerId",
          "customerId",
          "payoutId",
          "groupId",
          "partnerTagId",
          "type",
        ],
      }),
    [queryParams],
  );

  const onToggleOperator = useCallback(
    (key: string) => {
      const currentParam = searchParamsObj[key];
      if (!currentParam) return;
      const isNegated = currentParam.startsWith("-");
      const cleanValue = isNegated ? currentParam.slice(1) : currentParam;
      queryParams({
        set: { [key]: isNegated ? cleanValue : `-${cleanValue}` },
        del: "page",
      });
    },
    [searchParamsObj, queryParams],
  );

  const onOpenFilter = useCallback(
    (key: string | null) => setSelectedFilter(key),
    [],
  );

  return {
    filters,
    activeFilters,
    onSelect,
    onRemove,
    onRemoveFilter,
    onRemoveAll,
    onToggleOperator,
    onOpenFilter,
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

  const { partners, loading: partnersLoading } = usePartners({
    query: { search },
    enabled,
  });

  const activePartnerIds = useMemo(
    () =>
      searchParamsObj.partnerId
        ? searchParamsObj.partnerId.replace(/^-/, "").split(",").filter(Boolean)
        : undefined,
    [searchParamsObj.partnerId],
  );

  const { partners: selectedPartners, loading: selectedLoading } = usePartners({
    query: { partnerIds: activePartnerIds },
    enabled: !!activePartnerIds?.length,
  });

  const result = useMemo(() => {
    if (!enabled && !activePartnerIds?.length) return null;
    if (enabled && partnersLoading) return null;
    if (activePartnerIds?.length && selectedLoading) return null;

    return partnersLoading ||
      // Consider partners loading if we can't find all currently filtered partners
      (activePartnerIds?.length &&
        !activePartnerIds.every((id) =>
          [...(selectedPartners ?? []), ...(partners ?? [])].some(
            (p) => p.id === id,
          ),
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
    activePartnerIds,
  ]);

  return { partners: result };
}

function useCustomerFilterOptions({
  search,
  enabled = false,
}: {
  search: string;
  enabled?: boolean;
}) {
  const { searchParamsObj } = useRouterStuff();

  const { customers, loading: customersLoading } = useCustomers({
    query: { search },
    enabled,
  });

  const activeCustomerId = searchParamsObj.customerId;

  const { customers: selectedCustomers, loading: selectedLoading } =
    useCustomers({
      query: {
        customerIds: activeCustomerId ? [activeCustomerId] : undefined,
      },
      enabled: !!activeCustomerId,
    });

  const result = useMemo(() => {
    if (!enabled && !activeCustomerId) return null;
    if (enabled && customersLoading) return null;
    if (activeCustomerId && selectedLoading) return null;

    return customersLoading ||
      // Consider partners loading if we can't find the currently filtered partner
      (activeCustomerId &&
        ![...(selectedCustomers ?? []), ...(customers ?? [])].some(
          (p) => p.id === activeCustomerId,
        ))
      ? null
      : ([
          ...(customers ?? []),
          // Add selected partner to list if not already in partners
          ...(selectedCustomers
            ?.filter((st) => !customers?.some((t) => t.id === st.id))
            ?.map((st) => ({ ...st, hideDuringSearch: true })) ?? []),
        ] as (CustomerProps & { hideDuringSearch?: boolean })[]);
  }, [
    enabled,
    customersLoading,
    selectedLoading,
    customers,
    selectedCustomers,
    activeCustomerId,
  ]);

  return { customers: result };
}
