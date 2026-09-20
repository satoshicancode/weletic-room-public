import {
  FlowGrantListResponseSchema,
  FlowGrantMutationResponseSchema,
  FlowGrantsMerchantRequestSchema,
} from "../../../apps/web/lib/weletic/loyalty/flow-grants-merchant-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

/** Generate BEFORE dispatch and retain in the UI's pending operation. This is
 * an idempotency/recovery nonce, not authorization or a bearer token.
 */
export function newFlowGrantAttemptId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}
export function createMerchantFlowGrantsClient(
  getToken: () => Promise<string>,
  fetcher: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, fetcher);
  const parse = (value: unknown) => {
    const result = FlowGrantsMerchantRequestSchema.safeParse(value);
    if (!result.success) throw new StaffAccessClientError("invalid");
    return result.data;
  };
  return {
    // Only a definitive 400/pre-dispatch validation failure proves no commit.
    // Conflict, authentication, timeout and unavailable results stay uncertain.
    isNoncommittedError: (error: unknown) =>
      error instanceof StaffAccessClientError && error.code === "invalid",
    async list(input: unknown = {}) {
      const request = parse({ operation: "list", input });
      const result = FlowGrantListResponseSchema.safeParse(
        await post("/api/merchant/flow-grants", request),
      );
      if (
        !result.success ||
        (request.input.expectedInstallationGeneration &&
          result.data.installationGeneration !==
            request.input.expectedInstallationGeneration)
      )
        throw new StaffAccessClientError("unavailable");
      return result.data;
    },
    async write(value: unknown) {
      const request = parse(value);
      if (request.operation === "list")
        throw new StaffAccessClientError("invalid");
      const result = FlowGrantMutationResponseSchema.safeParse(
        await post("/api/merchant/flow-grants", request),
      );
      if (!result.success) throw new StaffAccessClientError("unavailable");
      const data = result.data;
      if (
        request.operation === "create"
          ? data.revision !== 1 || data.revokedAt !== null
          : data.id !== request.input.grantId ||
            data.revision !== request.input.expectedRevision + 1 ||
            data.revokedAt === null
      )
        throw new StaffAccessClientError("unavailable");
      return data;
    },
  };
}
