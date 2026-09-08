export function divideAndRoundCommission(
  numerator: bigint,
  denominator: bigint,
) {
  if (denominator <= BigInt(0)) {
    throw new Error("Commission denominator must be greater than zero.");
  }

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * BigInt(2) >= denominator ? quotient + BigInt(1) : quotient;
}

export function allocateCommissionProportionally({
  total,
  amounts,
}: {
  total: bigint;
  amounts: bigint[];
}) {
  if (amounts.length === 0) return [];
  const denominator = amounts.reduce(
    (sum, amount) => sum + (amount > BigInt(0) ? amount : BigInt(0)),
    BigInt(0),
  );
  if (denominator === BigInt(0)) {
    return amounts.map((_, index) =>
      index === amounts.length - 1 ? total : BigInt(0),
    );
  }
  let allocated = BigInt(0);
  return amounts.map((amount, index) => {
    const value =
      index === amounts.length - 1
        ? total - allocated
        : (total * (amount > BigInt(0) ? amount : BigInt(0))) / denominator;
    allocated += value;
    return value;
  });
}
