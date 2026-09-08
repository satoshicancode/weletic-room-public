import { expect, it } from "vitest";
import {
  loyaltyCommunicationJourneySchema,
  loyaltyCommunicationVariables,
  renderLoyaltyCommunicationText,
} from "../../lib/weletic/loyalty/communications-contract";
import { createDefaultLoyaltyCommunicationPolicy } from "../../ui/weletic/loyalty/communications-defaults";

it.each(loyaltyCommunicationJourneySchema.options)(
  "provides valid disabled EN/JA/VI defaults for %s",
  (journey) => {
    const policy = createDefaultLoyaltyCommunicationPolicy(journey);
    expect(policy.enabled).toBe(false);
    expect(Object.keys(policy.templates)).toEqual(["en", "ja", "vi"]);
    const values = Object.fromEntries(
      loyaltyCommunicationVariables[journey].map((name) => [
        name,
        `fixture-${name}`,
      ]),
    );
    for (const template of Object.values(policy.templates)) {
      for (const text of Object.values(template)) {
        expect(
          renderLoyaltyCommunicationText(text, journey, values),
        ).not.toMatch(/[{}]/);
      }
    }
    expect(policy.templates.ja.heading).not.toBe(policy.templates.en.heading);
    expect(policy.templates.vi.heading).not.toBe(policy.templates.en.heading);
  },
);
it("returns independent drafts so one editor cannot mutate another", () => {
  const first = createDefaultLoyaltyCommunicationPolicy("birthday");
  first.templates.en.subject = "Edited";
  expect(
    createDefaultLoyaltyCommunicationPolicy("birthday").templates.en.subject,
  ).not.toBe("Edited");
});
