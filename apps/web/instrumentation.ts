import { logger } from "@/lib/axiom/server";
import { createOnRequestError } from "@axiomhq/nextjs";

// Ensure BigInt serialization does not crash JSON.stringify in Next.js routes
if (!("toJSON" in BigInt.prototype)) {
  Object.defineProperty(BigInt.prototype, "toJSON", {
    value: function (this: bigint) {
      const num = Number(this);
      return Number.isSafeInteger(num) ? num : this.toString();
    },
    writable: true,
    configurable: true,
  });
}

export async function register() {
  if (!("toJSON" in BigInt.prototype)) {
    Object.defineProperty(BigInt.prototype, "toJSON", {
      value: function (this: bigint) {
        const num = Number(this);
        return Number.isSafeInteger(num) ? num : this.toString();
      },
      writable: true,
      configurable: true,
    });
  }
}

export const onRequestError = createOnRequestError(logger);
