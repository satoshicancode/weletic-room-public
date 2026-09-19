/** No Flow transport occurred. The queue must restore its exact claim without
 * spending a delivery attempt; do not use for ambiguous provider responses.
 */
export class ReviewFlowDeferredError extends Error {
  readonly retryAt = new Date(Date.now() + 60_000);
  constructor() {
    super("Review Flow deferred before transport");
    this.name = "ReviewFlowDeferredError";
  }
}
