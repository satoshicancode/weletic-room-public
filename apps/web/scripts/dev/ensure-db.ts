import fs from "node:fs";
import path from "node:path";

async function ensureDb() {
  console.log("🐘 [Database Setup] Checking SQLite / D1 database status...");

  const dbUrl = process.env.DATABASE_URL || "file:./prisma/schema/dev.db";

  if (dbUrl.startsWith("file:")) {
    const rawPath = dbUrl.replace(/^file:/, "");
    const resolvedPath = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(process.cwd(), rawPath);
    const dbDir = path.dirname(resolvedPath);

    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      console.log(`📁 Created SQLite database directory: ${dbDir}`);
    }

    console.log(`✅ [Database Setup] SQLite database ready at: ${resolvedPath}`);
  } else {
    console.log("☁️ [Database Setup] Using remote D1 / database connection.");
  }
}

ensureDb();

