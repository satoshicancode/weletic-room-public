import { fetcher } from "@dub/utils";
import useSWR, { SWRConfiguration } from "swr";
import * as z from "zod/v4";
import { getPlanCapabilities } from "../plan-capabilities";
import { CustomerProps } from "../types";
import { getCustomersQuerySchemaExtended } from "../zod/schemas/customers";
import useWorkspace from "./use-workspace";

const partialQuerySchema = getCustomersQuerySchemaExtended.partial();

export default function useCustomers(
  {
    query,
    enabled = true,
  }: {
    query?: z.infer<typeof partialQuerySchema>;
    enabled?: boolean;
  } = {},
  swrOptions?: SWRConfiguration,
) {
  const { id: workspaceId, plan } = useWorkspace();
  const { canManageCustomers } = getPlanCapabilities(plan);

  const {
    data: customers,
    isLoading,
    isValidating,
    error,
    mutate,
  } = useSWR<CustomerProps[]>(
    enabled && workspaceId && canManageCustomers
      ? `/api/customers?${new URLSearchParams({
          workspaceId: workspaceId,
          ...query,
        } as Record<string, any>).toString()}`
      : null,
    fetcher,
    swrOptions,
  );

  return {
    customers,
    loading: isLoading,
    isLoading,
    isValidating,
    error,
    mutate,
  };
}
