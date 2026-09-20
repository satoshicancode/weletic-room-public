import { Prisma } from "@prisma/client";
import {
  FLOW_ABSOLUTE_DELTA_MAX,
  FLOW_UNSIGNED_MAX,
} from "./flow-action-grant-contract";

/** Decode locked ORM values before exact arithmetic. This is not authorization.
 * Never round fractional values or pass a persisted budget through Number.
 */
export function readFlowGrantQuantities(row: {
  maxAbsolutePointsPerAction: Prisma.Decimal;
  absolutePointsBudget: Prisma.Decimal;
  absolutePointsUsed: Prisma.Decimal;
}) {
  const integer = (value: Prisma.Decimal, max: bigint, positive: boolean) => {
    if (!(value instanceof Prisma.Decimal) || !value.isInteger())
      throw new Error("Invalid stored Flow grant quantity");
    const text = value.toFixed();
    if (!/^(0|[1-9]\d{0,19})$/.test(text))
      throw new Error("Invalid stored Flow grant quantity");
    const exact = BigInt(text);
    if (exact > max || (positive && exact === BigInt(0)))
      throw new Error("Invalid stored Flow grant quantity");
    return exact;
  };
  const maxAbsolutePointsPerAction = integer(
    row.maxAbsolutePointsPerAction,
    FLOW_ABSOLUTE_DELTA_MAX,
    true,
  );
  const absolutePointsBudget = integer(
    row.absolutePointsBudget,
    FLOW_UNSIGNED_MAX,
    true,
  );
  const absolutePointsUsed = integer(
    row.absolutePointsUsed,
    FLOW_UNSIGNED_MAX,
    false,
  );
  if (
    maxAbsolutePointsPerAction > absolutePointsBudget ||
    absolutePointsUsed > absolutePointsBudget
  )
    throw new Error("Invalid stored Flow grant quantity");
  return {
    maxAbsolutePointsPerAction,
    absolutePointsBudget,
    absolutePointsUsed,
  };
}
