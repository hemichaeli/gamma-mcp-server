import http, { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer } from "./mcp.js";

// session map: sessionId -> transport
const transports = new Map<string, SSEServerTransport>();

const PORT = Number(process.env.PORT ?? 3000);

function logRequest(req: IncomingMessage) {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[${ts}] ${req.method} ${req.url}`);
}

async function handleHealth(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      status: "ok",
      service: "gamma-mcp-server",
      version: "1.0.0",
      transport: "sse",
      endpoints: {
        sse: "/sse",
        messages: "/messages",
        health: "/health",
      },
      sessions: transports.size,
      hasApiKey: Boolean(process.env.GAMMA_API_KEY),
    })
  );
}

async function handleSSE(req: IncomingMessage, res: ServerResponse) {
  // IMPORTANT: do NOT apply any body-parsing middleware upstream of this —
  // SSEServerTransport needs to own the request stream on /messages, and
  // the SSE connection here holds the response stream open indefinitely.
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);

  res.on("close", () => {
    transports.delete(transport.sessionId);
  });

  // Fresh McpServer per session — reusing one across sessions causes state leakage.
  const server = createMcpServer();
  try {
    await server.connect(transport);
    // transport.start() is called internally by server.connect()
  } catch (err) {
    console.error("SSE connect error:", err);
    transports.delete(transport.sessionId);
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
}

async function handleMessages(req: IncomingMessage, res: ServerResponse, url: URL) {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Missing sessionId query parameter");
    return;
  }
  const transport = transports.get(sessionId);
  if (!transport) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end(`No active session: ${sessionId}`);
    return;
  }

  try {
    // SSEServerTransport reads the raw request body itself — do not pre-parse it.
    await transport.handlePostMessage(req, res);
  } catch (err) {
    console.error("handlePostMessage error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal error handling message");
    }
  }
}

const server = http.createServer(async (req, res) => {
  logRequest(req);

  // CORS (permissive — this is a public MCP endpoint connected by AI clients)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-API-KEY, Mcp-Session-Id"
  );
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  try {
    if (path === "/" || path === "/health") {
      await handleHealth(req, res);
      return;
    }
    if (path === "/sse" && req.method === "GET") {
      await handleSSE(req, res);
      return;
    }
    if (path === "/messages" && req.method === "POST") {
      await handleMessages(req, res, url);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    console.error("Top-level handler error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal server error");
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`gamma-mcp-server listening on 0.0.0.0:${PORT}`);
  console.log(`  SSE:      GET  /sse`);
  console.log(`  Messages: POST /messages?sessionId=...`);
  console.log(`  Health:   GET  /health`);
  console.log(
    `  GAMMA_API_KEY: ${
      process.env.GAMMA_API_KEY ? "configured" : "NOT SET (tool calls will fail)"
    }`
  );
});

// Graceful shutdown
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`Received ${sig}, shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
