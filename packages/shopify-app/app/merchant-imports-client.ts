import {
  HISTORICAL_IMPORT_CLIENT_TIMEOUT_MS,
  historicalImportContextResponseSchema,
  historicalImportExecutionRequestSchema,
  historicalImportHistoryRequestSchema,
  historicalImportReconciliationRequestSchema,
  historicalImportStatusRequestSchema,
  historicalImportUploadSchema,
  verifyHistoricalImportExecutionResponse,
  verifyHistoricalImportHistoryResponse,
  verifyHistoricalImportPreparationResponse,
  verifyHistoricalImportReconciliationResponse,
  verifyHistoricalImportStatusResponse,
} from "../../../apps/web/lib/weletic/loyalty/historical-import-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

export function createMerchantImportExecutionClient(
  getToken: () => Promise<string>,
  expectedStoreId: string,
  fetcher: typeof fetch = fetch,
) {
  // Headroom for fresh authentication and the gateway's 35-second deadline.
  const post = createMerchantJsonPost(getToken, fetcher, {
    timeoutMs: HISTORICAL_IMPORT_CLIENT_TIMEOUT_MS,
  });
  return async (request: unknown) => {
    const input = historicalImportExecutionRequestSchema.safeParse(request);
    if (!input.success || !expectedStoreId)
      throw new StaffAccessClientError("invalid");
    const value = await post("/api/merchant/imports", { request: input.data });
    try {
      const result = verifyHistoricalImportExecutionResponse(input.data, value);
      if (result.storeId !== expectedStoreId)
        throw new Error("Import store mismatch");
      return result;
    } catch {
      throw new StaffAccessClientError("unavailable");
    }
  };
}

export function createMerchantImportReconciliationClient(
  getToken: () => Promise<string>,
  expectedStoreId: string,
  fetcher: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, fetcher, {
    timeoutMs: HISTORICAL_IMPORT_CLIENT_TIMEOUT_MS,
  });
  return async (request: unknown) => {
    const input =
      historicalImportReconciliationRequestSchema.safeParse(request);
    if (!input.success || !expectedStoreId)
      throw new StaffAccessClientError("invalid");
    const value = await post("/api/merchant/imports", { request: input.data });
    try {
      const result = verifyHistoricalImportReconciliationResponse(
        input.data,
        value,
      );
      if (result.storeId !== expectedStoreId)
        throw new Error("Import store mismatch");
      return result;
    } catch {
      throw new StaffAccessClientError("unavailable");
    }
  };
}

export function createMerchantImportHistoryClient(
  getToken: () => Promise<string>,
  expectedStoreId: string,
  fetcher: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, fetcher);
  return async (request: unknown) => {
    const input = historicalImportHistoryRequestSchema.safeParse(request);
    if (!input.success || !expectedStoreId)
      throw new StaffAccessClientError("invalid");
    const value = await post("/api/merchant/imports", { request: input.data });
    try {
      const result = verifyHistoricalImportHistoryResponse(input.data, value);
      if (result.storeId !== expectedStoreId)
        throw new Error("Import store mismatch");
      return result;
    } catch {
      throw new StaffAccessClientError("unavailable");
    }
  };
}

export function createMerchantImportStatusClient(
  getToken: () => Promise<string>,
  expectedStoreId: string,
  fetcher: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, fetcher);
  return async (request: unknown) => {
    const input = historicalImportStatusRequestSchema.safeParse(request);
    if (!input.success || !expectedStoreId)
      throw new StaffAccessClientError("invalid");
    const value = await post("/api/merchant/imports", { request: input.data });
    try {
      const result = verifyHistoricalImportStatusResponse(input.data, value);
      if (result.storeId !== expectedStoreId)
        throw new Error("Import store mismatch");
      return result;
    } catch {
      throw new StaffAccessClientError("unavailable");
    }
  };
}

export function createMerchantImportContextClient(
  getToken: () => Promise<string>,
  fetcher: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, fetcher);
  return async () => {
    const value = await post("/api/merchant/imports", {
      request: { operation: "context" },
    });
    const parsed = historicalImportContextResponseSchema.safeParse(value);
    if (!parsed.success) throw new StaffAccessClientError("unavailable");
    return parsed.data;
  };
}

export function createMerchantImportsClient(
  getToken: () => Promise<string>,
  expectedStoreId: string,
  fetcher: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, fetcher, {
    timeoutMs: HISTORICAL_IMPORT_CLIENT_TIMEOUT_MS,
  });
  return async (input: unknown) => {
    const parsed = historicalImportUploadSchema.safeParse(input);
    if (!parsed.success || !expectedStoreId)
      throw new StaffAccessClientError("invalid");
    const value = await post("/api/merchant/imports", parsed.data);
    try {
      const result = verifyHistoricalImportPreparationResponse(
        parsed.data.request,
        value,
      );
      if (result.storeId !== expectedStoreId)
        throw new Error("Import store mismatch");
      return result;
    } catch {
      throw new StaffAccessClientError("unavailable");
    }
  };
}
