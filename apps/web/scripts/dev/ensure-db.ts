import { execSync } from "node:child_process";

function isDockerRunning(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function ensureDockerAndDb() {
  console.log("🐘 [Database Setup] Checking Docker & Database status...");

  if (!isDockerRunning()) {
    console.log(
      "🐳 [Docker] Docker daemon is not running. Launching Docker Desktop...",
    );
    try {
      execSync("open -a Docker", { stdio: "ignore" });
    } catch (e) {
      console.warn("⚠️ Could not open Docker.app automatically:", e);
    }

    // Wait up to 30s for Docker daemon to become responsive
    let attempts = 0;
    while (attempts < 30) {
      if (isDockerRunning()) {
        console.log("🐳 [Docker] Docker daemon is now ready!");
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
      attempts++;
    }

    if (!isDockerRunning()) {
      console.warn(
        "⚠️ [Docker] Docker daemon did not respond in time. Proceeding anyway...",
      );
    }
  }

  try {
    console.log(
      "📦 [Docker Compose] Starting MySQL, PlanetScale proxy & Mailhog...",
    );
    execSync("docker compose up -d", { stdio: "inherit" });
    console.log("✅ [Database Setup] Database containers are ready.");
  } catch (err: any) {
    console.warn(
      "⚠️ [Docker Compose] Error starting docker compose:",
      err.message || err,
    );
  }
}

ensureDockerAndDb();
