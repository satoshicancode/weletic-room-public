import { assertCloudflareIngressPair } from "./ingress-policy.mjs";

// Private JSON arrives on stdin, never in command arguments or dotenv overlays.
// No provider SDK, filesystem credential discovery, network, or child process.
try {
  if (process.argv.length !== 2 || process.stdin.isTTY) throw new Error();
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error();
    chunks.push(chunk);
  }
  const result = assertCloudflareIngressPair(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  // Syntax errors can quote private JSON. Never print the original error.
  process.stderr.write("Cloudflare ingress preflight rejected input\n");
  process.exitCode = 1;
}
