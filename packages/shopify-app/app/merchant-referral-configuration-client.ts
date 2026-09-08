import { verifyReferralConfigurationAcknowledgement } from "../../../apps/web/lib/weletic/loyalty/referral-configuration-acknowledgement";
import {
  referralConfigurationRequestSchema,
  type ReferralConfigurationPause,
  type ReferralConfigurationWrite,
} from "../../../apps/web/lib/weletic/loyalty/referral-configuration-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";
export function createMerchantReferralConfigurationClient(
  getToken: () => Promise<string>,
  fetcher: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, fetcher);
  async function request(value: unknown) {
    const input = referralConfigurationRequestSchema.safeParse(value);
    if (!input.success) throw new StaffAccessClientError("invalid");
    const response = await post(
      "/api/merchant/referral-configuration",
      input.data,
    );
    try {
      return verifyReferralConfigurationAcknowledgement(input.data, response);
    } catch {
      throw new StaffAccessClientError("unavailable");
    }
  }
  return {
    read: () => request({ operation: "read" }),
    save: (input: ReferralConfigurationWrite) =>
      request({ operation: "save", input }),
    pause: (input: ReferralConfigurationPause) =>
      request({ operation: "pause", input }),
  };
}
