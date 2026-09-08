import { verifyEarningRuleAcknowledgement } from "../../../apps/web/lib/weletic/loyalty/earning-rule-acknowledgement";
import {
  shopifyEarningRulesInputSchema,
  type EarningRuleRetire,
  type EarningRuleWrite,
} from "../../../apps/web/lib/weletic/loyalty/earning-rule-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";
export function createMerchantEarningRulesClient(
  getToken: () => Promise<string>,
  fetcher: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, fetcher);
  async function request(value: unknown) {
    const input = shopifyEarningRulesInputSchema.safeParse(value);
    if (!input.success) throw new StaffAccessClientError("invalid");
    const response = await post("/api/merchant/earning-rules", input.data);
    try {
      return verifyEarningRuleAcknowledgement(input.data, response);
    } catch {
      throw new StaffAccessClientError("unavailable");
    }
  }
  return {
    read: () => request({ operation: "read" }),
    save: (input: EarningRuleWrite) => request({ operation: "save", input }),
    retire: (input: EarningRuleRetire) =>
      request({ operation: "retire", input }),
  };
}
