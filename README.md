# gamma-mcp-server

MCP server for the [Gamma public API v1.0](https://developers.gamma.app). Generate polished presentations, documents, webpages, and social posts programmatically through AI clients that speak MCP (Claude, ChatGPT, Cursor, etc.).

## Features

- **Full Gamma public API coverage** — all 5 endpoints wrapped as clean tools.
- **Create + poll built-in** — `gamma_generate` handles the async flow end-to-end and returns the final URL. Fire-and-forget available via `wait: false`.
- **SSE transport** — Streamable HTTP SSE, Node built-in `http` (no Express), factory `McpServer` per session.
- **Deployable to Railway** — zero-config deploy from GitHub with a single env var.

## Tools

| Tool | What it does |
|---|---|
| `gamma_generate` | Generate a presentation/document/webpage/social post from text. Creates and polls to completion by default. |
| `gamma_generate_from_template` | Generate from an existing single-page template Gamma with variable substitution. |
| `gamma_get_generation` | Poll the status of a generation job. |
| `gamma_list_themes` | List workspace themes (for `themeId`). |
| `gamma_list_folders` | List workspace folders (for `folderIds`). |

## Environment variables

| Name | Required | Description |
|---|---|---|
| `GAMMA_API_KEY` | Yes | API key from [gamma.app/settings/api-keys](https://gamma.app/settings/api-keys). Format `sk-gamma-...`. Requires Pro/Ultra/Teams/Business plan. |
| `PORT` | No | Listen port. Defaults to `3000`. Railway sets this automatically. |

## Local development

```bash
npm install
npm run build
GAMMA_API_KEY=sk-gamma-... npm start
```

The server listens on:
- `GET /sse` — open the SSE stream (MCP client connects here).
- `POST /messages?sessionId=...` — JSON-RPC messages from the client.
- `GET /health` — liveness + session count.

## Deploy to Railway

1. Push this repo to GitHub.
2. In Railway, deploy from the GitHub repo.
3. Set `GAMMA_API_KEY` in the service variables.
4. Generate a public domain.
5. Connect to Claude.ai as a custom connector with URL: `https://<your-domain>/sse`.

## Connect in Claude.ai

1. Settings → Connectors → Add custom connector.
2. URL: `https://<your-railway-domain>/sse`
3. Start a new chat and ask Claude to generate a deck. Example prompts:
   - "Build a 10-slide pitch deck on autonomous agents; professional tone; export as PDF."
   - "Using theme `abc123def`, generate a 1-page social post about our Q3 launch."

## API reference

See [developers.gamma.app](https://developers.gamma.app) for parameter details. All Zod schemas in `src/mcp.ts` map directly to the public API fields.

## Architecture notes

- Each SSE session gets its own `McpServer` instance via `createMcpServer()`. Reusing a server across sessions causes state leakage.
- Request bodies on `/messages` are not pre-parsed — `SSEServerTransport` owns the request stream.
- Build uses `esbuild --format=esm --packages=external` — `tsc` with heavy type packages tends to OOM in constrained build environments.
