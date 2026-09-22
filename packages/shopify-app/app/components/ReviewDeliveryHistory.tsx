import type { ReviewDeliveryHistory as History } from "../../../../apps/web/lib/weletic/reviews/delivery-history";
import { reviewDeliveryCopy } from "../review-delivery-copy";

export function ReviewDeliveryHistory({
  history,
  locale,
}: {
  history: History | null;
  locale: keyof typeof reviewDeliveryCopy;
}) {
  const copy = reviewDeliveryCopy[locale];
  if (!history) return <p>{copy.missing}</p>;
  const rows = [
    { key: "initial", label: copy.initial, ...history.initial },
    ...history.reminders.map((row) => ({
      key: String(row.sequence),
      label: `${copy.reminder} ${row.sequence}`,
      ...row,
    })),
  ];
  return (
    <section
      style={{ minWidth: 0, overflowWrap: "anywhere" }}
      aria-label={copy.title}
    >
      <h3>{copy.title}</h3>
      <p>{copy.note}</p>
      <ol style={{ paddingInlineStart: 24 }}>
        {rows.map((row) => (
          <li key={row.key}>
            <h4>{row.label}</h4>
            <p>{copy.outcomes[row.outcome]}</p>
            <p>
              {copy.scheduled}:{" "}
              <time dateTime={row.scheduledFor}>
                {new Date(row.scheduledFor).toLocaleString(locale)}
              </time>
            </p>
            <p>
              {copy.attempts}: {row.attempts}
            </p>
            {row.confirmedAt && (
              <p>
                {copy.confirmed}:{" "}
                <time dateTime={row.confirmedAt}>
                  {new Date(row.confirmedAt).toLocaleString(locale)}
                </time>
              </p>
            )}
          </li>
        ))}
      </ol>
      {!history.reminders.length && <p>{copy.empty}</p>}
    </section>
  );
}
