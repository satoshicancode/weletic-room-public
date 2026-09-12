import { installationAdmissionStatusSchema } from "../../../apps/web/lib/weletic/shopify/installation-admission-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

export function createInstallationStatusClient(
  getToken: () => Promise<string>,
  transport: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, transport);
  return async () => {
    const parsed = installationAdmissionStatusSchema.safeParse(
      await post("/api/installation/status", {}),
    );
    if (!parsed.success) throw new StaffAccessClientError("unavailable");
    return parsed.data;
  };
}
