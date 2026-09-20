// Disposable integration-test worker. Never accepts a deployed database or
// provider configuration; the parent deliberately kills this process.
async function run(message: unknown) {
  const database = new URL(process.env.DATABASE_URL ?? "");
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.LOYALTY_DATABASE_INTEGRATION !== "1" ||
    !process.send ||
    database.protocol !== "mysql:" ||
    database.hostname !== "127.0.0.1" ||
    !/^\/weletic_loyalty_it_[a-z0-9_]+$/.test(database.pathname)
  )
    throw new Error("Disposable local database required");
  const input = message as Record<string, unknown>;
  if (
    !input ||
    !["before_commit", "after_commit"].includes(String(input.phase)) ||
    typeof input.storeId !== "string" ||
    !input.storeId.startsWith("store-reviews-it-") ||
    typeof input.reviewId !== "string" ||
    !input.reviewId ||
    input.reviewId.length > 191
  )
    throw new Error("Synthetic fixture identity required");

  const { withReviewMutation } = await import(
    "../../../lib/weletic/reviews/transaction"
  );
  const { moderateReviewWithAuditInTransaction } = await import(
    "../../../lib/weletic/reviews/moderation-audit"
  );
  const holdForCrash = () =>
    new Promise<never>(() => {
      // This is a test-only crash barrier, not an application recovery loop.
      setInterval(() => {}, 1000);
      process.send!({ phase: input.phase });
    });
  await withReviewMutation(
    input.storeId,
    async (tx, generation) => {
      await moderateReviewWithAuditInTransaction({
        tx,
        storeId: input.storeId as string,
        generation,
        actor: { kind: "workspace", userId: "synthetic-crash-operator" },
        input: {
          reviewId: input.reviewId,
          version: 1,
          merchantReply: "One durable reply",
          reason: "merchant_reply",
        },
      });
      if (input.phase === "before_commit") await holdForCrash();
    },
    "g1",
  );
  await holdForCrash();
}

process.once("message", (message) => {
  void run(message).catch(() => {
    // Errors can include database credentials. Only report a fixed diagnostic.
    process.send?.({ failed: true });
    process.exitCode = 1;
    process.exit(1);
  });
});
