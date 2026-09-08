import { expect, it } from "vitest";
import {
  loyaltyCommunicationJourneySchema,
  loyaltyCommunicationPolicySchema,
  loyaltyCommunicationsRequestSchema,
  renderLoyaltyCommunicationText,
  verifyLoyaltyCommunicationsResponse,
} from "../../lib/weletic/loyalty/communications-contract";

const template = {
  subject: "An update from {{brand_name}}",
  heading: "Your loyalty update",
  body: "Hello {{ customer_first_name }}",
  actionLabel: "View your account",
};
const policy = {
  journey: "points_earned",
  enabled: false,
  templates: { en: template, ja: template, vi: template },
};

it("requires a changed revision, matching generation and exact saved policy acknowledgement", () => {
  const request = loyaltyCommunicationsRequestSchema.parse({
    operation: "save",
    expectedInstallationGeneration: "generation",
    expectedRevision: "a".repeat(64),
    policy,
  });
  const response = {
    storeId: "store",
    installationGeneration: "generation",
    revision: "b".repeat(64),
    capabilities: { configure: true },
    deliveryIntegration: "not_connected",
    policies: [policy],
  };
  expect(verifyLoyaltyCommunicationsResponse(request, response).revision).toBe(
    response.revision,
  );
  for (const change of [
    { revision: "a".repeat(64) },
    { installationGeneration: "old" },
    { policies: [] },
    { capabilities: { configure: false } },
    { policies: [{ ...policy, enabled: true }] },
    { policies: [policy, policy] },
  ]) {
    expect(() =>
      verifyLoyaltyCommunicationsResponse(request, { ...response, ...change }),
    ).toThrow();
  }
});

it.each(loyaltyCommunicationJourneySchema.options)(
  "accepts a complete localized %s policy",
  (journey) => {
    expect(
      loyaltyCommunicationPolicySchema.safeParse({ ...policy, journey })
        .success,
    ).toBe(true);
  },
);
it.each([
  "{{ email }}",
  "{{ tier_name }}",
  "{{ brand_name | escape }}",
  "{{{brand_name}}}",
  "<script>alert(1)</script>",
  "Subject\nBcc: attacker@example.test",
])("rejects unsafe or wrong-journey subject %s", (subject) => {
  expect(
    loyaltyCommunicationPolicySchema.safeParse({
      ...policy,
      templates: { ...policy.templates, en: { ...template, subject } },
    }).success,
  ).toBe(false);
});
it("requires every locale, strict authority fields and both write fences", () => {
  const save = {
    operation: "save",
    expectedInstallationGeneration: "fixture-generation",
    expectedRevision: "a".repeat(64),
    policy,
  };
  expect(loyaltyCommunicationsRequestSchema.safeParse(save).success).toBe(true);
  for (const field of [
    "expectedRevision",
    "expectedInstallationGeneration",
  ] as const) {
    expect(
      loyaltyCommunicationsRequestSchema.safeParse({
        ...save,
        [field]: undefined,
      }).success,
    ).toBe(false);
  }
  expect(
    loyaltyCommunicationsRequestSchema.safeParse({
      ...save,
      storeId: "another-store",
    }).success,
  ).toBe(false);
  expect(
    loyaltyCommunicationPolicySchema.safeParse({
      ...policy,
      templates: { en: template },
    }).success,
  ).toBe(false);
});
it("preserves exact values and does not evaluate replacement text", () => {
  expect(
    renderLoyaltyCommunicationText(
      "{{points}} {{points_label}}",
      "points_earned",
      { points: "9007199254740993", points_label: "{{brand_name}}" },
    ),
  ).toBe("9007199254740993 {{brand_name}}");
});
it("rejects missing, inherited and header-injecting event data", () => {
  expect(() =>
    renderLoyaltyCommunicationText("{{brand_name}}", "birthday", {}),
  ).toThrow();
  expect(() =>
    renderLoyaltyCommunicationText(
      "{{brand_name}}",
      "birthday",
      Object.create({ brand_name: "Inherited" }),
    ),
  ).toThrow();
  expect(() =>
    renderLoyaltyCommunicationText("{{brand_name}}", "birthday", {
      brand_name: "Store\r\nBcc: hidden",
    }),
  ).toThrow();
});
