import type { Prisma } from "@prisma/client";

/** In-memory legacy fixtures only: exercises credential/fence readers without
 * claiming SQL locking, public installation, or provider acceptance coverage. */
export function legacyCredentialSqlFixture({
  readStore,
  readInstallation,
}: {
  readStore: () => Promise<unknown>;
  readInstallation: (id: string) => Promise<unknown>;
}) {
  return {
    async queryRaw(query: Prisma.Sql) {
      const sql = query.strings.join("?");
      if (sql.includes("FROM InstalledIntegration")) {
        const id = query.values[0];
        if (typeof id !== "string") throw new Error("Expected installation ID");
        const installation = await readInstallation(id);
        return installation ? [installation] : [];
      }
      if (sql.includes("FROM WeleticShopifyStore")) {
        const store = await readStore();
        return store ? [store] : [];
      }
      // The callers model legacy stores without these optional records.
      if (
        sql.includes("FROM WeleticLoyaltyProgram") ||
        sql.includes("FROM WeleticShopifyShopPrivacyTombstone") ||
        sql.includes("FROM WeleticShopifyPendingInstallation") ||
        sql.includes("FROM WeleticShopifyInstallationCredential")
      )
        return [];
      throw new Error("Unhandled legacy credential fixture SQL");
    },
    async executeRaw(query: Prisma.Sql) {
      const sql = query.strings.join("?");
      if (
        !sql.includes("INSERT INTO WeleticShopifySessionCoordination") &&
        !sql.includes("UPDATE WeleticShopifySessionCoordination")
      )
        throw new Error("Unhandled legacy credential fixture SQL write");
      // No contention/promotion exists in these fixtures. Dedicated real-MySQL
      // tests prove the coordinator's revision and lease race semantics.
      return 1;
    },
  };
}
