import { fetcher } from "@dub/utils";
import useSWR, { SWRConfiguration } from "swr";
import * as z from "zod/v4";
import { PayoutResponse } from "../types";
import { payoutsQuerySchema } from "../zod/schemas/payouts";
import useWorkspace from "./use-workspace";

export default function usePayouts(
  {
    query,
    enabled = true,
  }: {
    query?: z.input<typeof payoutsQuerySchema>;
    enabled?: boolean;
  } = {},
  swrOptions?: SWRConfiguration,
) {
  const { id: workspaceId, defaultProgramId } = useWorkspace();

  const {
    data: payouts,
    isLoading,
    isValidating,
    error,
    mutate,
  } = useSWR<PayoutResponse[]>(
    enabled && workspaceId && defaultProgramId
      ? `/api/payouts?${new URLSearchParams({
          workspaceId,
          ...query,
        } as Record<string, any>).toString()}`
      : null,
    fetcher,
    swrOptions,
  );

  return {
    payouts,
    error,
    loading: isLoading,
    isLoading,
    isValidating,
    mutate,
  };
}
