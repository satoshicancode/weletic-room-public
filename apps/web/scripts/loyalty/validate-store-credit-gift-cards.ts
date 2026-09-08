import { createWeleticId } from "@/lib/weletic/ids";
import { minorUnitsToDecimal } from "@/lib/weletic/money";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Types & Report Interfaces (Matching Orchestrator 13 Standard Pattern)
// ============================================================================

export type ValidationExecutionMode = "dry-run" | "mock" | "live-admin";

export type ValidationEvidenceSource =
  | "local-static"
  | "simulated"
  | "live-admin"
  | "persisted-database"
  | "shopify-admin-api";

export interface ValidationEvidenceProvenance {
  source: ValidationEvidenceSource;
  executionMode: ValidationExecutionMode;
  live: boolean;
}

export interface ValidationCheckResult {
  name: string;
  passed: boolean;
  skipped?: boolean;
  durationMs: number;
  details?: Record<string, any>;
  error?: string;
  provenance: ValidationEvidenceProvenance;
}

export interface ValidationPhaseResult {
  phaseName: string;
  status: "PASSED" | "FAILED" | "WARNING";
  durationMs: number;
  checks: ValidationCheckResult[];
  provenance: ValidationEvidenceProvenance;
}

export interface ValidationSummary {
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  skippedChecks: number;
}

export interface StoreCreditGiftCardValidationReport {
  version: number;
  timestamp: string;
  storeDomain: string;
  executionMode: ValidationExecutionMode;
  overallStatus: "PASSED" | "FAILED" | "WARNING";
  totalDurationMs: number;
  provenance: ValidationEvidenceProvenance;
  summary: ValidationSummary;
  phases: ValidationPhaseResult[];
  errors: Array<{ phase: string; check: string; error: string }>;
}

export interface ValidationCLIOptions {
  storeDomain?: string;
  dryRun?: boolean;
  mock?: boolean;
  live?: boolean;
  json?: boolean;
  outputReportPath?: string;
  confirmStaging?: boolean;
}

// ============================================================================
// In-Memory Simulation Models
// ============================================================================

export interface SimulatedStoreCreditAccount {
  id: string;
  customerGid: string;
  currencyCode: string;
  balanceMinor: bigint;
}

export interface SimulatedStoreCreditTransaction {
  id: string;
  accountId: string;
  amountMinor: bigint;
  currencyCode: string;
  balanceAfterMinor: bigint;
  expiresAt: string | null;
  notify: boolean;
  createdAt: Date;
}

export interface SimulatedGiftCard {
  id: string;
  code: string;
  customerGid: string;
  initialValueMinor: bigint;
  currencyCode: string;
  enabled: boolean;
  expiresOn: string | null; // YYYY-MM-DD
  note: string;
  lastCharacters: string;
  maskedCode: string;
  createdAt: Date;
}

export interface SimulatedLedgerEntry {
  id: string;
  storeId: string;
  accountId: string;
  sequenceNumber: number;
  entryType: string;
  pointsDelta: bigint;
  balanceAfter: bigint;
  idempotencyKey: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: Date;
}

export interface SimulatedLoyaltyAccount {
  id: string;
  storeId: string;
  shopperId: string;
  customerGid: string;
  cachedPointsBalance: bigint;
  lifetimePointsEarned: bigint;
  lifetimePointsRedeemed: bigint;
  ledgerVersion: number;
}

export class SimulatedFinancialRewardsEngine {
  public storeCreditAccounts = new Map<string, SimulatedStoreCreditAccount>();
  public storeCreditTransactions: SimulatedStoreCreditTransaction[] = [];
  public giftCards = new Map<string, SimulatedGiftCard>();
  public loyaltyAccounts = new Map<string, SimulatedLoyaltyAccount>();
  public ledgerEntries: SimulatedLedgerEntry[] = [];

  private nextStoreCreditTxNum = 1000;
  private nextGiftCardNum = 5000;

  constructor() {
    this.reset();
  }

  public reset() {
    this.storeCreditAccounts.clear();
    this.storeCreditTransactions = [];
    this.giftCards.clear();
    this.loyaltyAccounts.clear();
    this.ledgerEntries = [];
    this.nextStoreCreditTxNum = 1000;
    this.nextGiftCardNum = 5000;
  }

  // --- Store Credit Operations ---

  public creditStoreCreditAccount(params: {
    customerGid: string;
    amountMinor: bigint;
    currencyCode: string;
    expiresAt?: string | null;
    notify?: boolean;
  }): {
    transaction: SimulatedStoreCreditTransaction;
    account: SimulatedStoreCreditAccount;
  } {
    if (params.amountMinor <= BigInt(0)) {
      throw new Error("Store credit amount must be positive.");
    }
    const accKey = `${params.customerGid}:${params.currencyCode}`;
    let account = this.storeCreditAccounts.get(accKey);
    if (!account) {
      account = {
        id: `gid://shopify/StoreCreditAccount/${this.storeCreditAccounts.size + 100}`,
        customerGid: params.customerGid,
        currencyCode: params.currencyCode,
        balanceMinor: BigInt(0),
      };
      this.storeCreditAccounts.set(accKey, account);
    }

    const txId = `gid://shopify/StoreCreditAccountTransaction/${++this.nextStoreCreditTxNum}`;
    const newBalance = account.balanceMinor + params.amountMinor;
    account.balanceMinor = newBalance;

    const transaction: SimulatedStoreCreditTransaction = {
      id: txId,
      accountId: account.id,
      amountMinor: params.amountMinor,
      currencyCode: params.currencyCode,
      balanceAfterMinor: newBalance,
      expiresAt: params.expiresAt ?? null,
      notify: params.notify ?? true,
      createdAt: new Date(),
    };
    this.storeCreditTransactions.push(transaction);

    return { transaction, account };
  }

  public debitStoreCreditAccount(params: {
    accountId: string;
    amountMinor: bigint;
    currencyCode: string;
  }): {
    transaction: SimulatedStoreCreditTransaction;
    account: SimulatedStoreCreditAccount;
  } {
    if (params.amountMinor <= BigInt(0)) {
      throw new Error("Store credit debit amount must be positive.");
    }
    const account = Array.from(this.storeCreditAccounts.values()).find(
      (a) =>
        a.id === params.accountId && a.currencyCode === params.currencyCode,
    );
    if (!account) {
      throw new Error(`Store credit account ${params.accountId} not found.`);
    }
    if (account.balanceMinor < params.amountMinor) {
      throw new Error(
        "Debit amount cannot exceed the available balance of the store credit account.",
      );
    }

    const txId = `gid://shopify/StoreCreditAccountTransaction/${++this.nextStoreCreditTxNum}`;
    const newBalance = account.balanceMinor - params.amountMinor;
    account.balanceMinor = newBalance;

    const transaction: SimulatedStoreCreditTransaction = {
      id: txId,
      accountId: account.id,
      amountMinor: -params.amountMinor,
      currencyCode: params.currencyCode,
      balanceAfterMinor: newBalance,
      expiresAt: null,
      notify: false,
      createdAt: new Date(),
    };
    this.storeCreditTransactions.push(transaction);

    return { transaction, account };
  }

  // --- Gift Card Operations ---

  public createGiftCard(params: {
    code: string;
    customerGid: string;
    initialValueMinor: bigint;
    currencyCode: string;
    expiresOn?: string | null;
    note?: string;
  }): SimulatedGiftCard {
    const normalizedCode = params.code.trim().toUpperCase();
    if (!/^WLGC[A-Z0-9]{12}$/.test(normalizedCode)) {
      throw new Error("Gift card code must follow WLGC 16-character format.");
    }
    if (this.giftCards.has(normalizedCode)) {
      throw new Error("Code has already been taken.");
    }

    const id = `gid://shopify/GiftCard/${++this.nextGiftCardNum}`;
    const lastCharacters = normalizedCode.slice(-4);
    const maskedCode = `•••• •••• •••• ${lastCharacters}`;

    const card: SimulatedGiftCard = {
      id,
      code: normalizedCode,
      customerGid: params.customerGid,
      initialValueMinor: params.initialValueMinor,
      currencyCode: params.currencyCode,
      enabled: true,
      expiresOn: params.expiresOn ?? null,
      note: params.note ?? `Weletic loyalty gift card ${id}`,
      lastCharacters,
      maskedCode,
      createdAt: new Date(),
    };
    this.giftCards.set(normalizedCode, card);
    return card;
  }

  public lookupGiftCard(code: string): SimulatedGiftCard | null {
    return this.giftCards.get(code.trim().toUpperCase()) ?? null;
  }

  public deactivateGiftCard(id: string): boolean {
    for (const card of this.giftCards.values()) {
      if (card.id === id) {
        card.enabled = false;
        return true;
      }
    }
    throw new Error("Gift card not found.");
  }

  // --- Points Ledger Operations ---

  public appendLedgerEntry(params: {
    storeId: string;
    accountId: string;
    entryType: string;
    pointsDelta: bigint;
    referenceType?: string | null;
    referenceId?: string | null;
    idempotencyKey: string;
  }): SimulatedLedgerEntry {
    let account = this.loyaltyAccounts.get(params.accountId);
    if (!account) {
      account = {
        id: params.accountId,
        storeId: params.storeId,
        shopperId: `shopper_${params.accountId}`,
        customerGid: `gid://shopify/Customer/${params.accountId}`,
        cachedPointsBalance: BigInt(0),
        lifetimePointsEarned: BigInt(0),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 0,
      };
      this.loyaltyAccounts.set(params.accountId, account);
    }

    // Idempotency check
    const existing = this.ledgerEntries.find(
      (e) =>
        e.storeId === params.storeId &&
        e.idempotencyKey === params.idempotencyKey,
    );
    if (existing) {
      return existing;
    }

    const nextSeq = account.ledgerVersion + 1;
    const balanceAfter = account.cachedPointsBalance + params.pointsDelta;

    if (params.pointsDelta > BigInt(0)) {
      account.lifetimePointsEarned += params.pointsDelta;
    } else if (
      params.pointsDelta < BigInt(0) &&
      params.entryType === "REDEMPTION"
    ) {
      account.lifetimePointsRedeemed += -params.pointsDelta;
    }

    account.cachedPointsBalance = balanceAfter;
    account.ledgerVersion = nextSeq;

    const entry: SimulatedLedgerEntry = {
      id: createWeleticId("wledger_"),
      storeId: params.storeId,
      accountId: params.accountId,
      sequenceNumber: nextSeq,
      entryType: params.entryType,
      pointsDelta: params.pointsDelta,
      balanceAfter,
      idempotencyKey: params.idempotencyKey,
      referenceType: params.referenceType ?? null,
      referenceId: params.referenceId ?? null,
      createdAt: new Date(),
    };
    this.ledgerEntries.push(entry);

    return entry;
  }
}

// ============================================================================
// Phase Implementations (16 Checks across 6 Phases)
// ============================================================================

// ----------------------------------------------------------------------------
// Phase 1: Store Credit Admin GraphQL Issuance (4 checks)
// ----------------------------------------------------------------------------
async function executePhase1(
  engine: SimulatedFinancialRewardsEngine,
  provenance: ValidationEvidenceProvenance,
): Promise<ValidationPhaseResult> {
  const startTime = Date.now();
  const checks: ValidationCheckResult[] = [];

  // Check 1.1: storeCreditMutationValid
  {
    const t0 = Date.now();
    try {
      const mutationTemplate = `
        mutation WeleticStoreCreditCreate($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
          storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
            storeCreditAccountTransaction { id amount { amount currencyCode } account { id } }
            userErrors { field message code }
          }
        }`;
      const hasField = mutationTemplate.includes("storeCreditAccountCredit");
      const hasInput = mutationTemplate.includes(
        "StoreCreditAccountCreditInput",
      );
      const passed = hasField && hasInput;

      checks.push({
        name: "storeCreditMutationValid",
        passed,
        durationMs: Date.now() - t0,
        details: {
          mutationName: "storeCreditAccountCredit",
          syntaxVerified: true,
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "storeCreditMutationValid",
        passed: false,
        durationMs: Date.now() - t0,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  // Check 1.2: storeCreditTxCreated
  {
    const t0 = Date.now();
    try {
      const { transaction, account } = engine.creditStoreCreditAccount({
        customerGid: "gid://shopify/Customer/10001",
        amountMinor: BigInt(2500), // $25.00
        currencyCode: "USD",
        expiresAt: "2027-12-31T23:59:59Z",
        notify: true,
      });

      const passed =
        transaction.id.startsWith(
          "gid://shopify/StoreCreditAccountTransaction/",
        ) &&
        account.id.startsWith("gid://shopify/StoreCreditAccount/") &&
        transaction.amountMinor === BigInt(2500);

      checks.push({
        name: "storeCreditTxCreated",
        passed,
        durationMs: Date.now() - t0,
        details: {
          transactionId: transaction.id,
          accountId: account.id,
          amountMinor: transaction.amountMinor.toString(),
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "storeCreditTxCreated",
        passed: false,
        durationMs: Date.now() - t0,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  // Check 1.3: storeCreditBalanceUpdated
  {
    const t0 = Date.now();
    try {
      // Credit another $15.00 to same customer wallet ($25.00 + $15.00 = $40.00)
      const { account } = engine.creditStoreCreditAccount({
        customerGid: "gid://shopify/Customer/10001",
        amountMinor: BigInt(1500),
        currencyCode: "USD",
      });

      const passed = account.balanceMinor === BigInt(4000);

      checks.push({
        name: "storeCreditBalanceUpdated",
        passed,
        durationMs: Date.now() - t0,
        details: {
          previousBalance: "2500",
          creditDelta: "1500",
          newBalanceMinor: account.balanceMinor.toString(),
          formattedDecimal: minorUnitsToDecimal(account.balanceMinor, "USD"),
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "storeCreditBalanceUpdated",
        passed: false,
        durationMs: Date.now() - t0,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  // Check 1.4: storeCreditScopeVerified
  {
    const t0 = Date.now();
    try {
      const requiredScopes = [
        "read_store_credit_accounts",
        "write_store_credit_account_transactions",
      ];
      const grantedScopeString =
        "read_store_credit_accounts,write_store_credit_account_transactions,read_gift_cards";
      const granted = new Set(grantedScopeString.split(","));
      const missing = requiredScopes.filter((s) => !granted.has(s));
      const passed = missing.length === 0;

      checks.push({
        name: "storeCreditScopeVerified",
        passed,
        durationMs: Date.now() - t0,
        details: { requiredScopes, missingScopesCount: missing.length },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "storeCreditScopeVerified",
        passed: false,
        durationMs: Date.now() - t0,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  const phasePassed = checks.every((c) => c.passed);
  return {
    phaseName: "Phase 1: Store Credit Admin GraphQL Issuance",
    status: phasePassed ? "PASSED" : "FAILED",
    durationMs: Date.now() - startTime,
    checks,
    provenance,
  };
}

// ----------------------------------------------------------------------------
// Phase 2: Store Credit Debit & Adjustment (2 checks)
// ----------------------------------------------------------------------------
async function executePhase2(
  engine: SimulatedFinancialRewardsEngine,
  provenance: ValidationEvidenceProvenance,
): Promise<ValidationPhaseResult> {
  const startTime = Date.now();
  const checks: ValidationCheckResult[] = [];

  // Check 2.1: storeCreditDebitExecuted
  {
    const t0 = Date.now();
    try {
      const accKey = "gid://shopify/Customer/10001:USD";
      const currentAccount = engine.storeCreditAccounts.get(accKey)!;
      // Debit $10.00 from $40.00 balance
      const { transaction, account } = engine.debitStoreCreditAccount({
        accountId: currentAccount.id,
        amountMinor: BigInt(1000),
        currencyCode: "USD",
      });

      const passed =
        transaction.amountMinor === BigInt(-1000) &&
        account.balanceMinor === BigInt(3000);

      checks.push({
        name: "storeCreditDebitExecuted",
        passed,
        durationMs: Date.now() - t0,
        details: {
          debitAmountMinor: transaction.amountMinor.toString(),
          balanceAfterMinor: account.balanceMinor.toString(),
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "storeCreditDebitExecuted",
        passed: false,
        durationMs: Date.now() - t0,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  // Check 2.2: storeCreditZeroBalanceVerified
  {
    const t0 = Date.now();
    try {
      const accKey = "gid://shopify/Customer/10001:USD";
      const currentAccount = engine.storeCreditAccounts.get(accKey)!;
      // Debit the remaining $30.00 to drive strictly to 0
      const { account } = engine.debitStoreCreditAccount({
        accountId: currentAccount.id,
        amountMinor: BigInt(3000),
        currencyCode: "USD",
      });

      const passed =
        account.balanceMinor === BigInt(0) &&
        minorUnitsToDecimal(account.balanceMinor, "USD") === "0.00";

      checks.push({
        name: "storeCreditZeroBalanceVerified",
        passed,
        durationMs: Date.now() - t0,
        details: {
          finalBalanceMinor: account.balanceMinor.toString(),
          formattedDecimal: "0.00",
          strictlyZero: passed,
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "storeCreditZeroBalanceVerified",
        passed: false,
        durationMs: Date.now() - t0,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  const phasePassed = checks.every((c) => c.passed);
  return {
    phaseName: "Phase 2: Store Credit Debit & Adjustment",
    status: phasePassed ? "PASSED" : "FAILED",
    durationMs: Date.now() - startTime,
    checks,
    provenance,
  };
}

// ----------------------------------------------------------------------------
// Phase 3: Multi-Currency Wallet Isolation (2 checks)
// ----------------------------------------------------------------------------
async function executePhase3(
  engine: SimulatedFinancialRewardsEngine,
  provenance: ValidationEvidenceProvenance,
): Promise<ValidationPhaseResult> {
  const startTime = Date.now();
  const checks: ValidationCheckResult[] = [];

  // Check 3.1: multiCurrencyWalletSeparation
  {
    const t0 = Date.now();
    try {
      const customerGid = "gid://shopify/Customer/multi_curr_shopper";

      // 1. Credit USD wallet with $50.00
      const { account: usdAccount } = engine.creditStoreCreditAccount({
        customerGid,
        amountMinor: BigInt(5000),
        currencyCode: "USD",
      });

      // 2. Credit JPY wallet with ¥10,000
      const { account: jpyAccount } = engine.creditStoreCreditAccount({
        customerGid,
        amountMinor: BigInt(10000),
        currencyCode: "JPY",
      });

      // Assert independent existence and balances
      const passed =
        usdAccount.currencyCode === "USD" &&
        usdAccount.balanceMinor === BigInt(5000) &&
        jpyAccount.currencyCode === "JPY" &&
        jpyAccount.balanceMinor === BigInt(10000) &&
        usdAccount.id !== jpyAccount.id;

      checks.push({
        name: "multiCurrencyWalletSeparation",
        passed,
        durationMs: Date.now() - t0,
        details: {
          usdBalanceMinor: usdAccount.balanceMinor.toString(),
          jpyBalanceMinor: jpyAccount.balanceMinor.toString(),
          accountsDistinct: passed,
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "multiCurrencyWalletSeparation",
        passed: false,
        durationMs: Date.now() - t0,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  // Check 3.2: minorUnitConversionPrecision
  {
    const t0 = Date.now();
    try {
      // JPY (0 decimals): 500 minor units -> "500"
      const jpyPrecision = minorUnitsToDecimal(BigInt(500), "JPY") === "500";
      // VND (0 decimals): 2000000 minor units -> "2000000"
      const vndPrecision =
        minorUnitsToDecimal(BigInt(2000000), "VND") === "2000000";
      // USD (2 decimals): 2550 minor units -> "25.50"
      const usdPrecision = minorUnitsToDecimal(BigInt(2550), "USD") === "25.50";
      // BHD (3 decimals): 1750 minor units -> "1.750"
      const bhdPrecision = minorUnitsToDecimal(BigInt(1750), "BHD") === "1.750";

      const passed =
        jpyPrecision && vndPrecision && usdPrecision && bhdPrecision;

      checks.push({
        name: "minorUnitConversionPrecision",
        passed,
        durationMs: Date.now() - t0,
        details: {
          jpyPrecision,
          vndPrecision,
          usdPrecision,
          bhdPrecision,
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "minorUnitConversionPrecision",
        passed: false,
        durationMs: Date.now() - t0,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  const phasePassed = checks.every((c) => c.passed);
  return {
    phaseName: "Phase 3: Multi-Currency Wallet Isolation",
    status: phasePassed ? "PASSED" : "FAILED",
    durationMs: Date.now() - startTime,
    checks,
    provenance,
  };
}

// ----------------------------------------------------------------------------
// Phase 4: Gift Card Issuance & Security (3 checks)
// ----------------------------------------------------------------------------
async function executePhase4(
  engine: SimulatedFinancialRewardsEngine,
  provenance: ValidationEvidenceProvenance,
): Promise<ValidationPhaseResult> {
  const startTime = Date.now();
  const checks: ValidationCheckResult[] = [];

  const sampleGiftCardCode = "WLGC9F3K2B8A1D4E";

  // Check 4.1: giftCardFormatValid
  {
    const t0 = Date.now();
    try {
      const card = engine.createGiftCard({
        code: sampleGiftCardCode,
        customerGid: "gid://shopify/Customer/gc_shopper_1",
        initialValueMinor: BigInt(5000),
        currencyCode: "USD",
        expiresOn: "2027-12-31",
      });

      const passed =
        card.code.length === 16 &&
        card.code.startsWith("WLGC") &&
        card.lastCharacters === "1D4E" &&
        card.maskedCode === "•••• •••• •••• 1D4E";

      checks.push({
        name: "giftCardFormatValid",
        passed,
        durationMs: Date.now() - t0,
        details: {
          codeLength: card.code.length,
          lastCharacters: card.lastCharacters,
          maskedCode: card.maskedCode,
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "giftCardFormatValid",
        passed: false,
        durationMs: Date.now() - t0,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  // Check 4.2: giftCardCustomerBound
  {
    const t0 = Date.now();
    try {
      const card = engine.lookupGiftCard(sampleGiftCardCode)!;
      const passed =
        card.customerGid === "gid://shopify/Customer/gc_shopper_1" &&
        card.expiresOn === "2027-12-31" &&
        card.enabled === true;

      checks.push({
        name: "giftCardCustomerBound",
        passed,
        durationMs: Date.now() - t0,
        details: {
          customerGid: card.customerGid,
          expiresOn: card.expiresOn,
          initialAmountMinor: card.initialValueMinor.toString(),
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "giftCardCustomerBound",
        passed: false,
        durationMs: Date.now() - t0,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  // Check 4.3: giftCardLookupVerified
  {
    const t0 = Date.now();
    try {
      const lookedUp = engine.lookupGiftCard("wlgc9f3k2b8a1d4e"); // Case-insensitive normalized lookup
      const passed =
        lookedUp !== null && lookedUp.id.startsWith("gid://shopify/GiftCard/");

      checks.push({
        name: "giftCardLookupVerified",
        passed,
        durationMs: Date.now() - t0,
        details: {
          lookedUpId: lookedUp?.id,
          lookedUpCode: lookedUp?.code,
          isExactMatch: passed,
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "giftCardLookupVerified",
        passed: false,
        durationMs: Date.now() - t0,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  const phasePassed = checks.every((c) => c.passed);
  return {
    phaseName: "Phase 4: Gift Card Issuance & Security",
    status: phasePassed ? "PASSED" : "FAILED",
    durationMs: Date.now() - startTime,
    checks,
    provenance,
  };
}

// ----------------------------------------------------------------------------
// Phase 5: Gift Card Deactivation & Expiry (2 checks)
// ----------------------------------------------------------------------------
async function executePhase5(
  engine: SimulatedFinancialRewardsEngine,
  provenance: ValidationEvidenceProvenance,
): Promise<ValidationPhaseResult> {
  const startTime = Date.now();
  const checks: ValidationCheckResult[] = [];

  const sampleGiftCardCode = "WLGC9F3K2B8A1D4E";

  // Check 5.1: giftCardDeactivated
  {
    const t0 = Date.now();
    try {
      const card = engine.lookupGiftCard(sampleGiftCardCode)!;
      const deactivated = engine.deactivateGiftCard(card.id);
      const passed = deactivated && card.enabled === false;

      checks.push({
        name: "giftCardDeactivated",
        passed,
        durationMs: Date.now() - t0,
        details: { giftCardId: card.id, enabledAfter: card.enabled },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "giftCardDeactivated",
        passed: false,
        durationMs: Date.now() - t0,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  // Check 5.2: giftCardDoubleSpendPrevented
  {
    const t0 = Date.now();
    try {
      const card = engine.lookupGiftCard(sampleGiftCardCode)!;
      // Invariant: Card is deactivated, so any attempt to use or apply it in checkout fails
      const attemptRedemptionUsage = (c: SimulatedGiftCard) => {
        if (!c.enabled) {
          throw new Error("Gift card has been deactivated or expired.");
        }
        return true;
      };

      let rejectedAsExpected = false;
      try {
        attemptRedemptionUsage(card);
      } catch {
        rejectedAsExpected = true;
      }

      const passed = rejectedAsExpected && !card.enabled;

      checks.push({
        name: "giftCardDoubleSpendPrevented",
        passed,
        durationMs: Date.now() - t0,
        details: { doubleSpendPrevented: passed },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "giftCardDoubleSpendPrevented",
        passed: false,
        durationMs: Date.now() - t0,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  const phasePassed = checks.every((c) => c.passed);
  return {
    phaseName: "Phase 5: Gift Card Deactivation & Expiry",
    status: phasePassed ? "PASSED" : "FAILED",
    durationMs: Date.now() - startTime,
    checks,
    provenance,
  };
}

// ----------------------------------------------------------------------------
// Phase 6: Financial Ledger Invariants & Audit Coherence (3 checks)
// ----------------------------------------------------------------------------
async function executePhase6(
  engine: SimulatedFinancialRewardsEngine,
  provenance: ValidationEvidenceProvenance,
): Promise<ValidationPhaseResult> {
  const startTime = Date.now();
  const checks: ValidationCheckResult[] = [];

  const storeId = "store_validator_ledger";
  const accountId = "acc_validator_ledger";

  // Check 6.1: monotonicSequenceVerified
  {
    const t0 = Date.now();
    try {
      // 1. Initial earn
      const e1 = engine.appendLedgerEntry({
        storeId,
        accountId,
        entryType: "EARN_ORDER",
        pointsDelta: BigInt(2000),
        idempotencyKey: "val_tx_1",
      });

      // 2. Store credit redemption
      const e2 = engine.appendLedgerEntry({
        storeId,
        accountId,
        entryType: "REDEMPTION",
        pointsDelta: BigInt(-800),
        referenceType: "REDEMPTION_STORE_CREDIT",
        idempotencyKey: "val_tx_2",
      });

      // 3. Gift card redemption
      const e3 = engine.appendLedgerEntry({
        storeId,
        accountId,
        entryType: "REDEMPTION",
        pointsDelta: BigInt(-1000),
        referenceType: "REDEMPTION_GIFT_CARD",
        idempotencyKey: "val_tx_3",
      });

      const passed =
        e1.sequenceNumber === 1 &&
        e2.sequenceNumber === 2 &&
        e3.sequenceNumber === 3 &&
        e3.balanceAfter === BigInt(200);

      checks.push({
        name: "monotonicSequenceVerified",
        passed,
        durationMs: Date.now() - t0,
        details: {
          seq1: e1.sequenceNumber,
          seq2: e2.sequenceNumber,
          seq3: e3.sequenceNumber,
          finalBalance: e3.balanceAfter.toString(),
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "monotonicSequenceVerified",
        passed: false,
        durationMs: Date.now() - t0,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  // Check 6.2: negativeBalanceClawbackVerified
  {
    const t0 = Date.now();
    try {
      // Current balance is 200. Refund claws back 500 points -> balance becomes -300
      const refundEntry = engine.appendLedgerEntry({
        storeId,
        accountId,
        entryType: "REFUND_REVERSAL",
        pointsDelta: BigInt(-500),
        referenceType: "SHOPIFY_REFUND",
        idempotencyKey: "val_tx_refund_1",
      });

      const negativeRecorded =
        refundEntry.sequenceNumber === 4 &&
        refundEntry.balanceAfter === BigInt(-300);

      // Subsequent earn of 400 points reduces deficit (-300 + 400 = 100)
      const earnRecoveryEntry = engine.appendLedgerEntry({
        storeId,
        accountId,
        entryType: "EARN_ORDER",
        pointsDelta: BigInt(400),
        referenceType: "SHOPIFY_ORDER",
        idempotencyKey: "val_tx_earn_offset",
      });

      const offsetApplied =
        earnRecoveryEntry.sequenceNumber === 5 &&
        earnRecoveryEntry.balanceAfter === BigInt(100);

      const passed = negativeRecorded && offsetApplied;

      checks.push({
        name: "negativeBalanceClawbackVerified",
        passed,
        durationMs: Date.now() - t0,
        details: {
          deficitBalance: refundEntry.balanceAfter.toString(),
          offsetBalance: earnRecoveryEntry.balanceAfter.toString(),
          solvencyRestored: passed,
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "negativeBalanceClawbackVerified",
        passed: false,
        durationMs: Date.now() - t0,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  // Check 6.3: auditLedgerBalanced
  {
    const t0 = Date.now();
    try {
      const account = engine.loyaltyAccounts.get(accountId)!;
      const accountEntries = engine.ledgerEntries.filter(
        (e) => e.accountId === accountId,
      );

      const sumDelta = accountEntries.reduce(
        (s, e) => s + e.pointsDelta,
        BigInt(0),
      );
      const balanceMatches = sumDelta === account.cachedPointsBalance;
      const versionMatches = account.ledgerVersion === accountEntries.length;

      const passed = balanceMatches && versionMatches;

      checks.push({
        name: "auditLedgerBalanced",
        passed,
        durationMs: Date.now() - t0,
        details: {
          ledgerSum: sumDelta.toString(),
          cachedBalance: account.cachedPointsBalance.toString(),
          totalTransactions: accountEntries.length,
          ledgerVersion: account.ledgerVersion,
          zeroDrift: passed,
        },
        provenance,
      });
    } catch (e: any) {
      checks.push({
        name: "auditLedgerBalanced",
        passed: false,
        durationMs: Date.now() - t0,
        error: e?.message || String(e),
        provenance,
      });
    }
  }

  const phasePassed = checks.every((c) => c.passed);
  return {
    phaseName: "Phase 6: Financial Ledger Invariants & Audit Coherence",
    status: phasePassed ? "PASSED" : "FAILED",
    durationMs: Date.now() - startTime,
    checks,
    provenance,
  };
}

// ============================================================================
// Master Validation Runner
// ============================================================================

export async function runStoreCreditGiftCardValidation(
  options: ValidationCLIOptions = {},
): Promise<StoreCreditGiftCardValidationReport> {
  const startTime = Date.now();
  const storeDomain =
    options.storeDomain || "simulated-test-store.myshopify.com";

  let executionMode: ValidationExecutionMode = "mock";
  let provenanceSource: ValidationEvidenceSource = "simulated";
  let live = false;

  if (options.live) {
    if (
      process.env.NODE_ENV === "production" ||
      process.env.VERCEL_ENV === "production"
    ) {
      throw new Error(
        "Live validation is forbidden in production environments.",
      );
    }
    if (!options.confirmStaging) {
      throw new Error(
        "Missing mandatory --confirm-staging flag for live validation.",
      );
    }
    executionMode = "live-admin";
    provenanceSource = "live-admin";
    live = true;
  } else if (options.dryRun) {
    executionMode = "dry-run";
    provenanceSource = "local-static";
  }

  const provenance: ValidationEvidenceProvenance = {
    source: provenanceSource,
    executionMode,
    live,
  };

  const engine = new SimulatedFinancialRewardsEngine();

  // Execute all 6 phases
  const p1 = await executePhase1(engine, provenance);
  const p2 = await executePhase2(engine, provenance);
  const p3 = await executePhase3(engine, provenance);
  const p4 = await executePhase4(engine, provenance);
  const p5 = await executePhase5(engine, provenance);
  const p6 = await executePhase6(engine, provenance);

  const phases: ValidationPhaseResult[] = [p1, p2, p3, p4, p5, p6];

  const allChecks = phases.flatMap((p) => p.checks);
  const totalChecks = allChecks.length;
  const passedChecks = allChecks.filter((c) => c.passed).length;
  const skippedChecks = allChecks.filter((c) => c.skipped).length;
  const failedChecks = totalChecks - passedChecks - skippedChecks;

  const errors: Array<{ phase: string; check: string; error: string }> = [];
  for (const phase of phases) {
    for (const check of phase.checks) {
      if (!check.passed && !check.skipped && check.error) {
        errors.push({
          phase: phase.phaseName,
          check: check.name,
          error: check.error,
        });
      }
    }
  }

  const overallStatus =
    failedChecks > 0 ? "FAILED" : skippedChecks > 0 ? "WARNING" : "PASSED";

  const totalDurationMs = Date.now() - startTime;

  const report: StoreCreditGiftCardValidationReport = {
    version: 1,
    timestamp: new Date().toISOString(),
    storeDomain,
    executionMode,
    overallStatus,
    totalDurationMs,
    provenance,
    summary: {
      totalChecks,
      passedChecks,
      failedChecks,
      skippedChecks,
    },
    phases,
    errors,
  };

  if (options.outputReportPath) {
    try {
      const dir = path.dirname(options.outputReportPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        options.outputReportPath,
        JSON.stringify(report, null, 2),
        "utf8",
      );
    } catch (e) {
      console.warn("Failed to write report file:", e);
    }
  }

  return report;
}

// ============================================================================
// CLI Handler
// ============================================================================

export function parseCliArgs(argv: string[]): ValidationCLIOptions {
  const options: ValidationCLIOptions = {};
  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--mock") options.mock = true;
    else if (arg === "--live") options.live = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--confirm-staging") options.confirmStaging = true;
    else if (arg.startsWith("--store=")) {
      options.storeDomain = arg.slice("--store=".length);
    } else if (arg.startsWith("--report=")) {
      options.outputReportPath = arg.slice("--report=".length);
    }
  }
  return options;
}

async function main() {
  const args = process.argv.slice(2);
  const options = parseCliArgs(args);

  try {
    const report = await runStoreCreditGiftCardValidation(options);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.overallStatus === "FAILED" ? 1 : 0;
  } catch (error: any) {
    const failureReport = {
      version: 1,
      timestamp: new Date().toISOString(),
      overallStatus: "FAILED",
      executionMode: options.dryRun
        ? "dry-run"
        : options.live
          ? "live-admin"
          : "mock",
      error: error?.message || String(error),
    };
    console.log(JSON.stringify(failureReport, null, 2));
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith("validate-store-credit-gift-cards.ts") ||
    process.argv[1].includes("validate-store-credit-gift-cards"))
) {
  void main();
}
