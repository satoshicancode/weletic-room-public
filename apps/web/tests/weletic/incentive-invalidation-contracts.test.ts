import { describe, expect, it } from "vitest";
import { reviewInvalidationAwardSchema } from "../../lib/weletic/reviews/incentive-decision";

describe("confirmed invalidation award parsing", () => {
  it.each(["abc", "1.5", "", "0", "-1", "01", "9223372036854775808"])(
    "rejects %s without throwing from safeParse",
    (points) => {
      expect(
        reviewInvalidationAwardSchema.safeParse({ kind: "points", points })
          .success,
      ).toBe(false);
    },
  );
  it("preserves the signed-BIGINT maximum exactly", () => {
    expect(
      reviewInvalidationAwardSchema.parse({
        kind: "points",
        points: "9223372036854775807",
      }),
    ).toEqual({ kind: "points", points: "9223372036854775807" });
  });
});
