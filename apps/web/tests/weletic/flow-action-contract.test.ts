import {
  FlowPointsActionSchema,
  flowPointsActionDigest,
  flowPointsActionRunKey,
} from "@/lib/weletic/loyalty/flow-action-contract";
import { describe, expect, it } from "vitest";

const action = {
  handle: "weletic-adjust-points" as const,
  shop_id: "42",
  shopify_domain: "fixture.myshopify.com",
  action_run_id: "run-1",
  properties: {
    customer_id: "gid://shopify/Customer/12",
    grant_id: `wflowgrant_${"a".repeat(20)}`,
    points_delta: "1",
  },
};
describe("owner-granted Flow action contract", () => {
  it.each(["1", "-1", "9223372036854775807", "-9223372036854775808"])(
    "accepts exact %s",
    (points_delta) => {
      expect(
        FlowPointsActionSchema.parse({
          ...action,
          properties: { ...action.properties, points_delta },
        }).properties.points_delta,
      ).toBe(points_delta);
    },
  );
  it.each([
    0,
    1,
    9007199254740992,
    "0",
    "-0",
    "01",
    "+1",
    "1.1",
    "1e2",
    "9223372036854775808",
    "-9223372036854775809",
    "1".repeat(100),
    "bad",
  ])("rejects noncanonical/unsafe points %s", (points_delta) => {
    expect(
      FlowPointsActionSchema.safeParse({
        ...action,
        properties: { ...action.properties, points_delta },
      }).success,
    ).toBe(false);
  });
  it.each([
    { handle: undefined },
    { handle: "unknown" },
    { shop_id: 9007199254740992 },
    { shopify_domain: "https://fixture.myshopify.com" },
    { staffId: "owner" },
    { installationGeneration: "new" },
    { action_run_id: "" },
  ])("rejects invalid routing or forged authority %j", (patch) => {
    expect(
      FlowPointsActionSchema.safeParse({ ...action, ...patch }).success,
    ).toBe(false);
  });
  it("normalizes shop reference without changing durable identity", () => {
    const normalized = FlowPointsActionSchema.parse({
      ...action,
      shop_id: "gid://shopify/Shop/42",
    });
    expect(flowPointsActionRunKey(normalized)).toBe(
      flowPointsActionRunKey(action),
    );
    expect(
      flowPointsActionDigest({
        ...action,
        shopify_domain: "alias.myshopify.com",
      }),
    ).toBe(flowPointsActionDigest(action));
  });
  it.each([
    { points_delta: "-1" },
    { customer_id: "gid://shopify/Customer/13" },
    { grant_id: `wflowgrant_${"b".repeat(20)}` },
  ])(
    "detects a changed run body without giving it another run key %j",
    (patch) => {
      const changed = {
        ...action,
        properties: { ...action.properties, ...patch },
      };
      expect(flowPointsActionRunKey(changed)).toBe(
        flowPointsActionRunKey(action),
      );
      expect(flowPointsActionDigest(changed)).not.toBe(
        flowPointsActionDigest(action),
      );
    },
  );
  it("rejects extra financial authority and private material", () => {
    expect(
      FlowPointsActionSchema.safeParse({
        ...action,
        properties: {
          ...action.properties,
          accountId: "foreign",
          email: "private@example.test",
        },
      }).success,
    ).toBe(false);
  });
});
