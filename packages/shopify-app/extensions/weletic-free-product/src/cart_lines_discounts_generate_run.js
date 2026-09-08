/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 * @typedef {{
 *   version: 1,
 *   productIds: string[],
 *   variantIds: string[],
 *   quantity: number,
 *   message: string,
 *   minimumSubtotal: string | null,
 * }} FreeProductConfig
 */

const MAX_ELIGIBLE_IDS = 100;
const MAX_REWARD_QUANTITY = 100;
const PRODUCT_DISCOUNT_CLASS = "PRODUCT";
const FIRST_SELECTION_STRATEGY = "FIRST";
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;
const NON_NEGATIVE_DECIMAL = /^\d+(?:\.\d+)?$/;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {RegExp} gidPattern
 * @returns {string[] | null}
 */
function parseGidList(value, gidPattern) {
  if (!Array.isArray(value) || value.length > MAX_ELIGIBLE_IDS) return null;
  if (
    !value.every((item) => typeof item === "string" && gidPattern.test(item))
  ) {
    return null;
  }
  return [...new Set(value)];
}

/**
 * @param {unknown} value
 * @returns {string | null | undefined}
 */
function parseOptionalDecimal(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !NON_NEGATIVE_DECIMAL.test(value)) {
    return undefined;
  }
  return value;
}

/**
 * Compares non-negative decimal strings without floating-point conversion.
 *
 * @param {string} left
 * @param {string} right
 */
function decimalIsGreaterThanOrEqual(left, right) {
  if (!NON_NEGATIVE_DECIMAL.test(left) || !NON_NEGATIVE_DECIMAL.test(right)) {
    return false;
  }
  const [leftIntegerRaw, leftFraction = ""] = left.split(".");
  const [rightIntegerRaw, rightFraction = ""] = right.split(".");
  const leftInteger = leftIntegerRaw.replace(/^0+(?=\d)/, "");
  const rightInteger = rightIntegerRaw.replace(/^0+(?=\d)/, "");
  if (leftInteger.length !== rightInteger.length) {
    return leftInteger.length > rightInteger.length;
  }
  if (leftInteger !== rightInteger) return leftInteger > rightInteger;

  const scale = Math.max(leftFraction.length, rightFraction.length);
  return leftFraction.padEnd(scale, "0") >= rightFraction.padEnd(scale, "0");
}

/**
 * Multiplies non-negative decimal strings without converting them to floating
 * point. Shopify stores the reward threshold in shop currency but supplies the
 * cart subtotal in presentment currency, so the threshold must be converted
 * using the Function input's presentment currency rate.
 *
 * @param {string} left
 * @param {string} right
 * @returns {string | null}
 */
function multiplyDecimals(left, right) {
  if (!NON_NEGATIVE_DECIMAL.test(left) || !NON_NEGATIVE_DECIMAL.test(right)) {
    return null;
  }

  const [leftInteger, leftFraction = ""] = left.split(".");
  const [rightInteger, rightFraction = ""] = right.split(".");
  const scale = leftFraction.length + rightFraction.length;
  const leftDigits = `${leftInteger}${leftFraction}`.replace(/^0+(?=\d)/, "");
  const rightDigits = `${rightInteger}${rightFraction}`.replace(
    /^0+(?=\d)/,
    "",
  );
  const product = (BigInt(leftDigits) * BigInt(rightDigits)).toString();

  if (scale === 0) return product;
  const padded = product.padStart(scale + 1, "0");
  const integer = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, "");
  return fraction.length > 0 ? `${integer}.${fraction}` : integer;
}

/**
 * Parses the per-discount metafield. Invalid or unknown versions fail closed so
 * a malformed merchant configuration can never become an unlimited discount.
 *
 * @param {string | null | undefined} rawValue
 * @returns {FreeProductConfig | null}
 */
export function parseFreeProductConfig(rawValue) {
  if (!rawValue) return null;

  try {
    const value = JSON.parse(rawValue);
    if (!isRecord(value) || value.version !== 1) return null;

    const productIds = parseGidList(value.productIds, PRODUCT_GID);
    const variantIds = parseGidList(value.variantIds, VARIANT_GID);
    if (
      !productIds ||
      !variantIds ||
      productIds.length + variantIds.length === 0
    ) {
      return null;
    }
    if (
      !Number.isInteger(value.quantity) ||
      Number(value.quantity) < 1 ||
      Number(value.quantity) > MAX_REWARD_QUANTITY
    ) {
      return null;
    }
    const minimumSubtotal = parseOptionalDecimal(value.minimumSubtotal);
    if (minimumSubtotal === undefined) return null;

    const message =
      typeof value.message === "string" && value.message.trim().length > 0
        ? value.message.trim().slice(0, 255)
        : "Free product reward";

    return {
      version: 1,
      productIds,
      variantIds,
      quantity: Number(value.quantity),
      message,
      minimumSubtotal,
    };
  } catch {
    return null;
  }
}

/**
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */

export function cartLinesDiscountsGenerateRun(input) {
  if (
    !input.cart.lines.length ||
    !input.discount.discountClasses.includes(PRODUCT_DISCOUNT_CLASS)
  ) {
    return { operations: [] };
  }

  const config = parseFreeProductConfig(input.discount.metafield?.value);
  if (!config) {
    return { operations: [] };
  }
  if (config.minimumSubtotal !== null) {
    const presentmentMinimumSubtotal = multiplyDecimals(
      config.minimumSubtotal,
      input.presentmentCurrencyRate,
    );
    if (
      presentmentMinimumSubtotal === null ||
      !decimalIsGreaterThanOrEqual(
        input.cart.cost.subtotalAmount.amount,
        presentmentMinimumSubtotal,
      )
    ) {
      return { operations: [] };
    }
  }

  const eligibleProductIds = new Set(config.productIds);
  const eligibleVariantIds = new Set(config.variantIds);
  const targets = [];
  let remainingQuantity = config.quantity;

  for (const line of input.cart.lines) {
    if (remainingQuantity === 0) break;
    if (line.merchandise.__typename !== "ProductVariant") continue;

    const eligible =
      eligibleVariantIds.has(line.merchandise.id) ||
      eligibleProductIds.has(line.merchandise.product.id);
    if (!eligible || !Number.isInteger(line.quantity) || line.quantity < 1) {
      continue;
    }

    const quantity = Math.min(line.quantity, remainingQuantity);
    targets.push({ cartLine: { id: line.id, quantity } });
    remainingQuantity -= quantity;
  }

  if (targets.length === 0) return { operations: [] };

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates: [
            {
              message: config.message,
              targets,
              value: { percentage: { value: 100 } },
            },
          ],
          selectionStrategy: FIRST_SELECTION_STRATEGY,
        },
      },
    ],
  };
}
