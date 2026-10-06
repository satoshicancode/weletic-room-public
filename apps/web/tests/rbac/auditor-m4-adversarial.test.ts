import { getPermissionsByRole } from "@/lib/api/rbac/permissions";
import { permissionRegistry } from "@/lib/api/rbac/plugin-registry";
import { RESOURCE_KEYS } from "@/lib/api/rbac/resources";
import { SCOPES } from "@/lib/api/tokens/scopes";
import {
  executeTransferPreProcessingHook,
  registerTransferPreProcessingHook,
  transferHookRegistry,
  TransferPreProcessingContext,
} from "@/lib/partners/transfer-hooks";
import { weleticSettlementHook } from "@/lib/weletic/payouts/settlement-hook";
import { describe, expect, it } from "vitest";

describe("Auditor M4 Adversarial Stress Testing", () => {
  describe("RBAC Plugin Registry Proxy & Array Methods", () => {
    it("Proxy supports array iteration, map, filter, includes, and length correctly", () => {
      // Test RESOURCE_KEYS
      expect(Array.isArray(Array.from(RESOURCE_KEYS))).toBe(true);
      expect(RESOURCE_KEYS.length).toBeGreaterThan(0);
      expect(RESOURCE_KEYS.includes("loyalty" as any)).toBe(true);
      expect(RESOURCE_KEYS.indexOf("loyalty" as any)).toBeGreaterThanOrEqual(0);

      const mapped = Array.from(RESOURCE_KEYS).map((k) => k.toUpperCase());
      expect(mapped).toContain("LOYALTY");

      // Test SCOPES
      expect(SCOPES.length).toBeGreaterThan(0);
      expect(SCOPES.includes("loyalty.read" as any)).toBe(true);
      expect(SCOPES.includes("loyalty.write" as any)).toBe(true);
      expect(SCOPES.indexOf("loyalty.read" as any)).toBeGreaterThanOrEqual(0);

      const scopesList = Array.from(SCOPES);
      expect(scopesList).toContain("loyalty.read");
      expect(scopesList).toContain("loyalty.write");
    });

    it("handles registration of duplicate actions idempotently", () => {
      const initialCount = permissionRegistry.getRegisteredActions().length;
      permissionRegistry.register([
        {
          action: "loyalty.read",
          description: "duplicate registration",
          roles: ["owner"],
        },
      ]);
      expect(permissionRegistry.getRegisteredActions().length).toBe(
        initialCount,
      );
    });

    it("handles actions without resource or scope cleanly", () => {
      permissionRegistry.register([
        {
          action: "headless.action",
          description: "action without resource or scope",
          roles: ["owner"],
        },
      ]);
      expect(getPermissionsByRole("owner")).toContain("headless.action");
      expect(getPermissionsByRole("viewer")).not.toContain("headless.action");
    });
  });

  describe("Transfer Hook Registry Chaining & Error Boundaries", () => {
    it("chains hooks in registration order if early hook returns void/null", async () => {
      transferHookRegistry.clear();

      let hook1Called = false;
      let hook2Called = false;

      registerTransferPreProcessingHook(async () => {
        hook1Called = true;
        return; // pass through
      });

      registerTransferPreProcessingHook(async (ctx) => {
        hook2Called = true;
        return {
          finalTransferableAmount: ctx.totalTransferableAmount - 50,
          settlementCurrency: "usd",
        };
      });

      const context: TransferPreProcessingContext = {
        partner: { id: "p1" },
        allPayouts: [],
        totalTransferableAmount: 1000,
        withdrawalFee: 0,
        forceWithdrawal: false,
      };

      const result = await executeTransferPreProcessingHook(context);
      expect(hook1Called).toBe(true);
      expect(hook2Called).toBe(true);
      expect(result?.finalTransferableAmount).toBe(950);
    });

    it("stops chain immediately when a hook returns a result", async () => {
      transferHookRegistry.clear();

      let hook2Called = false;

      registerTransferPreProcessingHook(async () => ({
        finalTransferableAmount: 500,
        settlementCurrency: "usd",
      }));

      registerTransferPreProcessingHook(async () => {
        hook2Called = true;
        return {
          finalTransferableAmount: 200,
          settlementCurrency: "usd",
        };
      });

      const result = await executeTransferPreProcessingHook({
        partner: { id: "p1" },
        allPayouts: [],
        totalTransferableAmount: 1000,
        withdrawalFee: 0,
        forceWithdrawal: false,
      });

      expect(result?.finalTransferableAmount).toBe(500);
      expect(hook2Called).toBe(false);
    });
  });

  describe("Settlement Hook Edge Cases", () => {
    it("rejects when any payout has non-USD currency", async () => {
      await expect(
        weleticSettlementHook({
          partner: { id: "p1" },
          allPayouts: [
            {
              id: "p1",
              amount: 100,
              currency: "USD",
              program: {
                id: "pr1",
                name: "PR1",
                logo: null,
                workspaceId: "ws1",
              },
            } as any,
            {
              id: "p2",
              amount: 100,
              currency: "JPY",
              program: {
                id: "pr1",
                name: "PR1",
                logo: null,
                workspaceId: "ws1",
              },
            } as any,
          ],
          totalTransferableAmount: 200,
          withdrawalFee: 0,
          forceWithdrawal: false,
        }),
      ).rejects.toThrow(
        "Automatic Stripe settlement currently requires USD accounting payouts.",
      );
    });
  });
});
