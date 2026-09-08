import { verifyEarningRuleAcknowledgement } from "./earning-rule-acknowledgement";
import {
  shopifyEarningRulesInputSchema,
  type EarningRuleRetire,
  type EarningRuleWrite,
} from "./earning-rule-contract";

export function createWorkspaceEarningRulesClient(
  workspaceId: string,
  fetcher: typeof fetch = fetch,
) {
  if (!workspaceId.trim()) throw new Error("Workspace is required");
  const url = `/api/weletic/earning-rules?workspaceId=${encodeURIComponent(workspaceId)}`;
  async function request(value: unknown) {
    const input = shopifyEarningRulesInputSchema.parse(value);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new Error("Earning rule result is uncertain. Reload before saving"),
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
      if (!response.ok) throw new Error("Earning rule request failed");
      return verifyEarningRuleAcknowledgement(input, await response.json());
    };
    try {
      return await Promise.race([operation(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    read: () => request({ operation: "read" }),
    save: (input: EarningRuleWrite) => request({ operation: "save", input }),
    retire: (input: EarningRuleRetire) =>
      request({ operation: "retire", input }),
  };
}
