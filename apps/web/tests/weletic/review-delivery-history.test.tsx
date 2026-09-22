import {
  reviewDeliveryOutcome as outcome,
  reviewDeliveryHistorySchema,
} from "@/lib/weletic/reviews/delivery-history";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ReviewDeliveryHistory } from "../../../../packages/shopify-app/app/components/ReviewDeliveryHistory";
import { reviewDeliveryCopy as copy } from "../../../../packages/shopify-app/app/review-delivery-copy";

it.each([
  "sent",
  "submitted",
  "expired",
  "cancelled",
  "failed",
  "reconciliation",
])("preserves confirmed evidence across %s lifecycle state", (status) => {
  expect(outcome({ status, attempts: 1, sentAt: new Date() })).toBe(
    "confirmed",
  );
});
it.each(["failed", "expired", "cancelled", "submitted", "sent"])(
  "does not invent a successful send for attempted %s",
  (status) => {
    expect(outcome({ status, attempts: 1, sentAt: null })).toBe("unconfirmed");
  },
);
it.each([
  ["queued", "queued"],
  ["sending", "unavailable"],
  ["cancelled", "cancelled"],
  ["expired", "cancelled"],
  ["submitted", "unavailable"],
  ["sent", "unavailable"],
  ["unknown", "unavailable"],
])("projects zero-attempt %s conservatively", (status, expected) => {
  expect(outcome({ status, attempts: 0, sentAt: null })).toBe(expected);
});
it.each([
  [null, "unconfirmed"],
  [new Date("2026-09-20T00:00:00Z"), "unconfirmed"],
  [new Date("2026-09-20T00:00:01Z"), "sending"],
])(
  "requires a live lease before claiming an attempt is in progress",
  (leaseExpiresAt, expected) => {
    expect(
      outcome(
        { status: "sending", attempts: 1, sentAt: null, leaseExpiresAt },
        new Date("2026-09-20T00:00:00Z"),
      ),
    ).toBe(expected);
  },
);
const delivery = {
  outcome: "confirmed" as const,
  attempts: 1,
  scheduledFor: "2026-09-20T00:00:00.000Z",
  confirmedAt: "2026-09-20T00:01:00.000Z",
};
const history = {
  initial: delivery,
  reminders: [
    {
      sequence: 1,
      ...delivery,
      outcome: "unconfirmed" as const,
      confirmedAt: null,
    },
  ],
};
it.each(["en", "ja", "vi"] as const)(
  "renders truthful labelled history in %s without operational identifiers",
  (locale) => {
    const html = renderToStaticMarkup(
      <ReviewDeliveryHistory history={history} locale={locale} />,
    );
    expect(html).toContain(copy[locale].title);
    expect(html).toContain(copy[locale].note);
    expect(html).toContain(copy[locale].outcomes.unconfirmed);
    expect(html).toContain(`${copy[locale].reminder} 1`);
    expect(html).not.toMatch(/shopperId|requestId|wrevrem_|token|mailto:/);
  },
);
it("distinguishes unavailable history from an observed empty reminder list", () => {
  expect(
    renderToStaticMarkup(<ReviewDeliveryHistory history={null} locale="en" />),
  ).toContain(copy.en.missing);
  expect(
    renderToStaticMarkup(
      <ReviewDeliveryHistory
        history={{ initial: delivery, reminders: [] }}
        locale="en"
      />,
    ),
  ).toContain(copy.en.empty);
});
it.each([
  { ...history, email: "private@example.test" },
  { ...history, reminders: [{ ...history.reminders[0], token: "secret" }] },
  { ...history, reminders: [history.reminders[0], history.reminders[0]] },
  { ...history, reminders: [{ ...history.reminders[0], sequence: 4 }] },
  { ...history, initial: { ...delivery, confirmedAt: null } },
  { ...history, initial: { ...delivery, outcome: "unconfirmed" } },
])("rejects private fields and corrupt or duplicated schedules", (value) => {
  expect(reviewDeliveryHistorySchema.safeParse(value).success).toBe(false);
});
