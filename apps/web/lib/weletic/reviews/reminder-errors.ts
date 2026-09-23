/** Queue-control errors contain no shopper or provider data. */
export class ReviewReminderDeferredError extends Error {
  constructor(readonly retryAt: Date) {
    super("Review reminder deferred before transport");
    this.name = "ReviewReminderDeferredError";
    if (!Number.isFinite(retryAt.getTime()))
      throw new Error("Invalid reminder retry time");
  }
}
export class ReviewReminderReconciliationError extends Error {
  constructor() {
    super("Review reminder requires delivery reconciliation");
    this.name = "ReviewReminderReconciliationError";
  }
}
