import { DEFAULT_OPEN_REVIEW_POLICY } from "@/lib/weletic/reviews/open-policy-contract";
import { describe, expect, it, vi } from "vitest";
import { createMerchantOpenReviewPolicyClient } from "../../../../packages/shopify-app/app/merchant-open-review-policy-client";

const command = {
  expectedInstallationGeneration: "g1",
  expectedRevision: 2,
  policy: DEFAULT_OPEN_REVIEW_POLICY,
};
describe("open policy browser client", () => {
  it("uses fresh bearer auth without cookies or caller identity", async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(
        Response.json({ revision: 3, policy: command.policy }),
      );
    const token = vi.fn().mockResolvedValue("synthetic-token");
    await createMerchantOpenReviewPolicyClient(token, transport).save(command);
    expect(token).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(
      "/api/merchant/open-review-policy/write",
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        body: JSON.stringify(command),
        headers: {
          Authorization: "Bearer synthetic-token",
          "Content-Type": "application/json",
        },
      }),
    );
  });
  it.each([401, 403, 409, 503])("does not retry HTTP %s", async (status) => {
    const transport = vi.fn().mockResolvedValue(new Response(null, { status }));
    await expect(
      createMerchantOpenReviewPolicyClient(async () => "token", transport).save(
        command,
      ),
    ).rejects.toMatchObject({
      code: {
        401: "reauthenticate",
        403: "denied",
        409: "reload",
        503: "unavailable",
      }[status],
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rejects extra authority before requesting a token", async () => {
    const token = vi.fn();
    const transport = vi.fn();
    await expect(
      createMerchantOpenReviewPolicyClient(token, transport).save({
        ...command,
        storeId: "foreign",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(token).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    { revision: 2, policy: command.policy },
    { revision: 3, policy: { ...command.policy, enabled: true } },
    { revision: 3, policy: { ...command.policy, photoUploadsEnabled: true } },
    { revision: 3, policy: { ...command.policy, maxSubmissionsPer24Hours: 4 } },
  ])("rejects a mismatched save receipt", async (receipt) => {
    const transport = vi.fn().mockResolvedValue(Response.json(receipt));
    await expect(
      createMerchantOpenReviewPolicyClient(async () => "token", transport).save(
        command,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rejects contradictory installation state on read", async () => {
    const transport = vi.fn().mockResolvedValue(
      Response.json({
        revision: 1,
        policy: { ...command.policy, enabled: true },
        installationGeneration: "g1",
        requiresReauthorization: true,
        policyEnabledForInstallation: true,
      }),
    );
    await expect(
      createMerchantOpenReviewPolicyClient(
        async () => "token",
        transport,
      ).read(),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});
