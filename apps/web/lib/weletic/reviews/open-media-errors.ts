import { ReviewError } from "./contracts";

/** Only emitted by image normalization before this invocation reserves or PUTs. */
export class InvalidOpenReviewPhoto extends ReviewError {
  constructor() {
    super("bad_request", "Photo could not be validated");
  }
}

/** Internal signal emitted only after exact authorized retry evidence matches.
 * Never serialize the media identity or expose this as a recovery API.
 */
export class OpenPhotoReconciliationRequired extends ReviewError {
  constructor(readonly mediaId: string) {
    super("unavailable", "Photo storage outcome requires reconciliation");
  }
}

/** Maintenance-only signal: exclusive open ownership has an unsettled PUT. */
export class OpenPhotoCleanupReconciliationRequired extends ReviewError {
  constructor() {
    super("unavailable", "Photo storage outcome requires reconciliation");
  }
}
