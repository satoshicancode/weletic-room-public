import { createServer } from "node:http";

const host = "127.0.0.1";
const port = Number(process.env.E2E_QSTASH_PORT ?? 8090);

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (request.method === "POST" && request.url?.startsWith("/v2/publish/")) {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ messageId: `e2e-${Date.now()}` }));
    return;
  }

  request.resume();
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, host, () => {
  process.stdout.write(`QStash E2E mock listening on http://${host}:${port}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
