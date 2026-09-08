import { BlockStack, Button, Select, Text, TextField } from "@shopify/polaris";
import { useState } from "react";
import {
  auditedReviewModerationInputSchema,
  reviewModerationReasonSchema,
  type AuditedReviewModerationInput,
} from "../../../../apps/web/lib/weletic/reviews/moderation-contract";
import { reviewModerationCopy } from "../review-moderation-copy";

export function ReviewModerationForm({
  review,
  locale,
  disabled,
  save,
}: {
  review: { id: string; version: number; merchantReply: string | null };
  locale: keyof typeof reviewModerationCopy;
  disabled: boolean;
  save: (input: AuditedReviewModerationInput) => Promise<void>;
}) {
  const copy = reviewModerationCopy[locale];
  const [status, setStatus] = useState("");
  const [reply, setReply] = useState(review.merchantReply ?? "");
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState("");
  const [invalid, setInvalid] = useState(false);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        const merchantReply = reply.trim() || null;
        const parsed = auditedReviewModerationInputSchema.safeParse({
          reviewId: review.id,
          version: review.version,
          ...(status ? { status } : {}),
          ...(merchantReply !== review.merchantReply ? { merchantReply } : {}),
          reason,
          ...(details.trim() ? { reasonDetails: details.trim() } : {}),
        });
        setInvalid(!parsed.success);
        if (parsed.success) void save(parsed.data);
      }}
    >
      <BlockStack gap="200">
        <Text as="h3" variant="headingSm">
          {copy.heading}
        </Text>
        <Text as="p">{copy.help}</Text>
        <Select
          label={copy.status}
          value={status}
          onChange={setStatus}
          disabled={disabled}
          options={[
            { label: copy.keep, value: "" },
            ...(["published", "hidden", "rejected"] as const).map((value) => ({
              label: copy[value],
              value,
            })),
          ]}
        />
        <TextField
          label={copy.reply}
          value={reply}
          onChange={setReply}
          disabled={disabled}
          autoComplete="off"
          multiline={3}
          maxLength={5000}
        />
        <Select
          label={copy.reason}
          value={reason}
          onChange={setReason}
          disabled={disabled}
          options={[
            { label: copy.choose, value: "" },
            ...reviewModerationReasonSchema.options.map((value) => ({
              label: copy.reasons[value],
              value,
            })),
          ]}
        />
        <TextField
          label={copy.details}
          value={details}
          onChange={setDetails}
          disabled={disabled}
          autoComplete="off"
          multiline={2}
          maxLength={1000}
        />
        {invalid && <p role="alert">{copy.invalid}</p>}
        <Button submit disabled={disabled}>
          {copy.save}
        </Button>
      </BlockStack>
    </form>
  );
}
