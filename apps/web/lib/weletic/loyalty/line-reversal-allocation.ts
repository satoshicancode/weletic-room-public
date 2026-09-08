export interface LineReversalSnapshot {
  id: string;
  orderLineId: string;
  storeId: string;
  awardedPoints: bigint;
  reversedPoints: bigint;
  isExcluded: boolean;
}

export interface LineReversalAllocation extends LineReversalSnapshot {
  pointsToReverse: bigint;
}

function compareOrderLineIds(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Deterministically spreads a reversal across each eligible line's remaining
 * awarded-point capacity. Largest-remainder allocation provides exact integer
 * conservation, and orderLineId is the stable tie-break and lock order.
 */
export function allocateReversalAcrossRemainingLines({
  grantId,
  storeId,
  grossPoints,
  alreadyReversedPoints,
  pointsToAllocate,
  lineEarns,
}: {
  grantId: string;
  storeId: string;
  grossPoints: bigint;
  alreadyReversedPoints: bigint;
  pointsToAllocate: bigint;
  lineEarns: LineReversalSnapshot[];
}): LineReversalAllocation[] {
  if (pointsToAllocate <= BigInt(0)) {
    return [];
  }

  const normalizedLines = lineEarns.map((line) => {
    if (line.storeId !== storeId) {
      throw new Error(
        `Loyalty earn grant ${grantId} has a cross-tenant line allocation`,
      );
    }
    if (
      line.awardedPoints < BigInt(0) ||
      line.reversedPoints < BigInt(0) ||
      line.reversedPoints > line.awardedPoints
    ) {
      throw new Error(
        `Line reversal invariant failed for loyalty earn grant ${grantId}`,
      );
    }

    return {
      ...line,
      remainingCapacity: line.awardedPoints - line.reversedPoints,
    };
  });
  const eligibleSnapshots = normalizedLines.filter((line) => !line.isExcluded);
  const allocatedGrossPoints = eligibleSnapshots.reduce(
    (sum, line) => sum + line.awardedPoints,
    BigInt(0),
  );
  const allocatedReversedPoints = eligibleSnapshots.reduce(
    (sum, line) => sum + line.reversedPoints,
    BigInt(0),
  );
  if (
    allocatedGrossPoints !== grossPoints ||
    allocatedReversedPoints !== alreadyReversedPoints
  ) {
    throw new Error(
      `Source allocation invariant failed for loyalty earn grant ${grantId}`,
    );
  }

  const eligibleLines = eligibleSnapshots.filter(
    (line) => line.remainingCapacity > BigInt(0),
  );
  const totalRemainingCapacity = eligibleLines.reduce(
    (sum, line) => sum + line.remainingCapacity,
    BigInt(0),
  );
  if (totalRemainingCapacity < pointsToAllocate) {
    throw new Error(
      `Line reversal capacity is insufficient for loyalty earn grant ${grantId}`,
    );
  }

  const weighted = eligibleLines.map((line) => {
    const numerator = pointsToAllocate * line.remainingCapacity;
    return {
      ...line,
      pointsToReverse: numerator / totalRemainingCapacity,
      remainder: numerator % totalRemainingCapacity,
    };
  });
  const baseAllocated = weighted.reduce(
    (sum, line) => sum + line.pointsToReverse,
    BigInt(0),
  );
  let unallocated = pointsToAllocate - baseAllocated;

  weighted.sort((a, b) => {
    if (a.remainder !== b.remainder) {
      return a.remainder > b.remainder ? -1 : 1;
    }
    return compareOrderLineIds(a.orderLineId, b.orderLineId);
  });
  for (const line of weighted) {
    if (unallocated <= BigInt(0)) break;
    if (line.pointsToReverse < line.remainingCapacity) {
      line.pointsToReverse += BigInt(1);
      unallocated -= BigInt(1);
    }
  }

  const allocated = weighted.reduce(
    (sum, line) => sum + line.pointsToReverse,
    BigInt(0),
  );
  if (unallocated !== BigInt(0) || allocated !== pointsToAllocate) {
    throw new Error(
      `Line reversal conservation failed for loyalty earn grant ${grantId}`,
    );
  }

  return weighted
    .filter((line) => line.pointsToReverse > BigInt(0))
    .sort((a, b) => compareOrderLineIds(a.orderLineId, b.orderLineId))
    .map((line) => ({
      id: line.id,
      orderLineId: line.orderLineId,
      storeId: line.storeId,
      awardedPoints: line.awardedPoints,
      reversedPoints: line.reversedPoints,
      isExcluded: line.isExcluded,
      pointsToReverse: line.pointsToReverse,
    }));
}
