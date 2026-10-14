import http from "node:http";
import net from "node:net";

interface StoredEmail {
  to: string;
  body: string;
  receivedAt: Date;
}

const storedEmails: StoredEmail[] = [];
let smtpServer: net.Server | null = null;
let httpServer: http.Server | null = null;

export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once("error", () => resolve(false))
      .once("listening", () => {
        tester.once("close", () => resolve(true)).close();
      })
      .listen(port);
  });
}

export async function startMockMailhog() {
  // If port 8025 or 1025 is already in use, assume real MailHog or prior instance
  const httpAvailable = await isPortAvailable(8025);
  const smtpAvailable = await isPortAvailable(1025);

  if (!httpAvailable || !smtpAvailable) {
    return;
  }

  // 1. SMTP Server on port 1025
  smtpServer = net.createServer((socket) => {
    let inDataMode = false;
    let dataBuffer = "";
    let currentTo = "";

    socket.write("220 mock-mailhog ESMTP\r\n");

    socket.on("data", (chunk) => {
      const text = chunk.toString();

      if (inDataMode) {
        dataBuffer += text;
        if (
          dataBuffer.includes("\r\n.\r\n") ||
          dataBuffer.endsWith("\n.\n") ||
          dataBuffer.endsWith("\n.\r\n")
        ) {
          inDataMode = false;
          storedEmails.push({
            to: currentTo,
            body: dataBuffer,
            receivedAt: new Date(),
          });
          dataBuffer = "";
          currentTo = "";
          socket.write("250 OK: message queued\r\n");
        }
        return;
      }

      const lines = text.split("\r\n").filter(Boolean);
      for (const line of lines) {
        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
          socket.write("250-localhost\r\n250 8BITMIME\r\n");
        } else if (upper.startsWith("MAIL FROM:")) {
          socket.write("250 OK\r\n");
        } else if (upper.startsWith("RCPT TO:")) {
          const match = line.match(/<([^>]+)>/);
          currentTo = match
            ? match[1]
            : line.replace(/^RCPT TO:\s*/i, "").trim();
          socket.write("250 OK\r\n");
        } else if (upper.startsWith("DATA")) {
          inDataMode = true;
          dataBuffer = "";
          socket.write("354 Start mail input; end with <CRLF>.<CRLF>\r\n");
        } else if (upper.startsWith("RSET")) {
          inDataMode = false;
          dataBuffer = "";
          currentTo = "";
          socket.write("250 OK\r\n");
        } else if (upper.startsWith("NOOP")) {
          socket.write("250 OK\r\n");
        } else if (upper.startsWith("QUIT")) {
          socket.write("221 Bye\r\n");
          socket.end();
        } else {
          socket.write("250 OK\r\n");
        }
      }
    });

    socket.on("error", () => {});
  });

  smtpServer.listen(1025);

  // 2. HTTP Server on port 8025
  httpServer = http.createServer((req, res) => {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost:8025"}`,
    );

    if (url.pathname === "/api/v2/search") {
      const query = url.searchParams.get("query")?.toLowerCase() || "";
      const matched = storedEmails.filter(
        (m) =>
          !query ||
          m.to.toLowerCase().includes(query) ||
          m.body.toLowerCase().includes(query),
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          total: matched.length,
          count: matched.length,
          start: 0,
          items: matched
            .slice()
            .reverse()
            .map((m) => ({
              Content: {
                Body: m.body,
                Headers: { To: [m.to] },
              },
            })),
        }),
      );
      return;
    }

    if (url.pathname === "/api/v2/messages") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          total: storedEmails.length,
          count: storedEmails.length,
          start: 0,
          items: storedEmails
            .slice()
            .reverse()
            .map((m) => ({
              Content: {
                Body: m.body,
                Headers: { To: [m.to] },
              },
            })),
        }),
      );
      return;
    }

    if (url.pathname === "/api/v1/messages" && req.method === "DELETE") {
      storedEmails.length = 0;
      res.writeHead(200);
      res.end();
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  });

  httpServer.listen(8025);
}

export function stopMockMailhog() {
  try {
    smtpServer?.close();
  } catch {}
  try {
    httpServer?.close();
  } catch {}
}
