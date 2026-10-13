import { Prisma } from "@prisma/client";

export interface TransferPreProcessingContext {
  partner: {
    id: string;
    email?: string | null;
    stripeConnectId?: string | null;
  };
  allPayouts: Array<
    Prisma.PayoutGetPayload<{
      include: {
        program: {
          select: {
            id: true;
            name: true;
            logo: true;
            workspaceId: true;
          };
        };
      };
    }>
  >;
  totalTransferableAmount: number;
  withdrawalFee: number;
  forceWithdrawal: boolean;
}

export interface TransferPreProcessingResult {
  finalTransferableAmount: number;
  settlementCurrency: string;
}

export type TransferPreProcessingHook = (
  context: TransferPreProcessingContext,
) => Promise<TransferPreProcessingResult | void>;

class TransferHookRegistry {
  private hooks: TransferPreProcessingHook[] = [];

  public registerPreProcessingHook(
    hook: TransferPreProcessingHook,
  ): () => void {
    this.hooks.push(hook);
    return () => {
      this.hooks = this.hooks.filter((h) => h !== hook);
    };
  }

  public async executePreProcessingHook(
    context: TransferPreProcessingContext,
  ): Promise<TransferPreProcessingResult | null> {
    for (const hook of this.hooks) {
      const result = await hook(context);
      if (result) {
        return result;
      }
    }
    return null;
  }

  public clear(): void {
    this.hooks = [];
  }
}

export const transferHookRegistry = new TransferHookRegistry();

export const registerTransferPreProcessingHook = (
  hook: TransferPreProcessingHook,
) => transferHookRegistry.registerPreProcessingHook(hook);

export const executeTransferPreProcessingHook = (
  context: TransferPreProcessingContext,
) => transferHookRegistry.executePreProcessingHook(context);
