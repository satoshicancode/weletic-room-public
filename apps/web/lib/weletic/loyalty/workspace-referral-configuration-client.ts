import { verifyReferralConfigurationAcknowledgement } from "./referral-configuration-acknowledgement";
import {
  referralConfigurationRequestSchema,
  type ReferralConfigurationPause,
  type ReferralConfigurationWrite,
} from "./referral-configuration-contract";

export function createWorkspaceReferralConfigurationClient(
  workspaceId: string,
  fetcher: typeof fetch = fetch,
) {
  if (!workspaceId.trim()) throw new Error("Workspace is required");
  const url = `/api/weletic/referral-configuration?workspaceId=${encodeURIComponent(workspaceId)}`;
  async function request(value: unknown) {
    const input = referralConfigurationRequestSchema.parse(value);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new Error(
            "Referral configuration result is uncertain. Reload before saving",
          ),
        );
      }, 8000);
    });
    const operation = async () => {
      const response = await fetcher(url, {
        method: input.operation === "read" ? "GET" : "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        ...(input.operation === "read"
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(input),
            }),
      });
      if (!response.ok)
        throw new Error("Referral configuration request failed");
      return verifyReferralConfigurationAcknowledgement(
        input,
        await response.json(),
      );
    };
    try {
      return await Promise.race([operation(), deadline]);
    } finally {
      clearTimeout(timer);
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
