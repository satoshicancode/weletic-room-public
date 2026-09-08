import "dotenv-flow/config";
import { spawn } from "node:child_process";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  magenta: "\x1b[35m",
};

async function main() {
  const token = process.env.CLOUDFLARE_TUNNEL_TOKEN;
  const namedTunnel = process.env.CLOUDFLARE_TUNNEL_NAME;

  let tunnelArgs: string[] = [];

  if (token) {
    console.log(
      `${colors.bold}${colors.green}[Cloudflare Named Tunnel]${colors.reset} 🔒 Connecting with Cloudflare Zero Trust Token...`,
    );
    tunnelArgs = ["tunnel", "run", "--token", token];
  } else if (namedTunnel) {
    console.log(
      `${colors.bold}${colors.green}[Cloudflare Named Tunnel]${colors.reset} 🔒 Connecting named tunnel '${namedTunnel}' using ingress rules (dev-webhook.weletic.com -> 8888, shopify.weletic.com -> 3000)...`,
    );
    tunnelArgs = ["tunnel", "run", namedTunnel];
  } else {
    console.log(
      `${colors.bold}${colors.cyan}[Cloudflare Quick Tunnel]${colors.reset} 🌐 Starting free Cloudflare Quick Tunnel on http://localhost:8888...`,
    );
    console.log(
      `${colors.gray}Tip: Set CLOUDFLARE_TUNNEL_TOKEN in .env to use a persistent named domain!${colors.reset}\n`,
    );
    tunnelArgs = ["tunnel", "--url", "http://localhost:8888"];
  }

  const child = spawn("cloudflared", tunnelArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const extractUrlRegex = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    const match = text.match(extractUrlRegex);
    if (match) {
      console.log(
        `\n${colors.bold}${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`,
      );
      console.log(
        `${colors.bold}🌐 CLOUDFLARE TUNNEL ONLINE:${colors.reset} ${colors.bold}${colors.cyan}${match[0]}${colors.reset}`,
      );
      console.log(
        `${colors.bold}🔗 Webhook Endpoint:${colors.reset}       ${colors.cyan}${match[0]}/api/shopify/integration/webhook${colors.reset}`,
      );
      console.log(
        `${colors.bold}${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${colors.reset}`,
      );
    } else {
      process.stdout.write(
        `${colors.gray}[cloudflared] ${text}${colors.reset}`,
      );
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    const match = text.match(extractUrlRegex);
    if (match) {
      console.log(
        `\n${colors.bold}${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`,
      );
      console.log(
        `${colors.bold}🌐 CLOUDFLARE TUNNEL ONLINE:${colors.reset} ${colors.bold}${colors.cyan}${match[0]}${colors.reset}`,
      );
      console.log(
        `${colors.bold}🔗 Webhook Endpoint:${colors.reset}       ${colors.cyan}${match[0]}/api/shopify/integration/webhook${colors.reset}`,
      );
      console.log(
        `${colors.bold}${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${colors.reset}`,
      );
    } else if (
      text.includes("Registered tunnel connection") ||
      text.includes("Connection") ||
      text.includes("Route propagation")
    ) {
      console.log(`${colors.gray}[cloudflared] ${text.trim()}${colors.reset}`);
    }
  });

  child.on("exit", (code) => {
    console.log(
      `${colors.yellow}[Cloudflare Tunnel] Process exited with code ${code}${colors.reset}`,
    );
  });
}

main().catch(console.error);
