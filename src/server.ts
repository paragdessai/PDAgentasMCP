/**********************************************************************
 * Jokes + Copilot MCP Server
 * --------------------------------------------------------------------
 * • Provides four joke tools
 * • Adds `ask-copilot-agent` tool that forwards a prompt to
 *   a Copilot Studio agent via Direct Line REST API.
 *********************************************************************/

import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";                 // ✅ NEW – for params schema

// ─────────────────────────────────────────────────────────────
// ⚠️  HARD-CODED Direct Line secret
//     (safe only in private repos / test environments)
const DIRECT_LINE_SECRET = "YOUR_DIRECT_LINE_SECRET_HERE";
// ─────────────────────────────────────────────────────────────

/* ───── MCP server manifest ───────────────────────────────── */
const server = new McpServer({
  name: "jokesMCP",
  description: "A server that provides jokes and can query a Copilot Studio agent",
  version: "1.1.0",
  tools: [
    { name: "get-chuck-joke",       description: "Get a random Chuck Norris joke",      parameters: {} },
    { name: "get-chuck-categories", description: "Get all available Chuck categories",  parameters: {} },
    { name: "get-dad-joke",         description: "Get a random dad joke",               parameters: {} },
    { name: "get-yo-mama-joke",     description: "Get a random Yo-Mama joke",           parameters: {} },
    {
      name: "ask-copilot-agent",
      description: "Send a prompt to the Copilot Studio agent and return its reply",
      parameters: {
        type: "object",
        properties: { prompt: { type: "string" } },
        required: ["prompt"]
      }
    }
  ],
});

/* ───── Joke tools (unchanged) ────────────────────────────── */
server.tool("get-chuck-joke",       "", async () => {
  const r = await fetch("https://api.chucknorris.io/jokes/random");
  const d = await r.json();
  return { content: [{ type: "text", text: d.value }] };
});

server.tool("get-chuck-categories", "", async () => {
  const r = await fetch("https://api.chucknorris.io/jokes/categories");
  const d = await r.json();
  return { content: [{ type: "text", text: d.join(", ") }] };
});

server.tool("get-dad-joke",         "", async () => {
  const r = await fetch("https://icanhazdadjoke.com/", { headers: { Accept: "application/json" } });
  const d = await r.json();
  return { content: [{ type: "text", text: d.joke }] };
});

server.tool("get-yo-mama-joke",     "", async () => {
  const r = await fetch("https://www.yomama-jokes.com/api/v1/jokes/random");
  const d = await r.json();
  return { content: [{ type: "text", text: d.joke }] };
});

/* ───── ask-copilot-agent tool (fixed overload) ───────────── */
server.tool(
  "ask-copilot-agent",
  { prompt: z.string() },                                // 👈 schema, satisfies overload #2
  async ({ prompt }: { prompt: string }) => {
    const DL = "https://directline.botframework.com/v3/directline";

    // 1️⃣  create conversation
    const conv = await fetch(`${DL}/conversations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${DIRECT_LINE_SECRET}` }
    }).then(r => r.json());
    const { conversationId } = conv;

    // 2️⃣  post user prompt
    await fetch(`${DL}/conversations/${conversationId}/activities`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DIRECT_LINE_SECRET}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        type: "message",
        from: { id: "mcp-user" },
        text: prompt
      })
    });

    // 3️⃣  poll up to 10 s for first bot reply
    const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
    let reply = "The agent didn’t respond in time.";
    for (let i = 0; i < 10; i++) {
      await wait(1000);
      const acts = await fetch(`${DL}/conversations/${conversationId}/activities`, {
        headers: { Authorization: `Bearer ${DIRECT_LINE_SECRET}` }
      }).then(r => r.json());

      const botMsg = acts.activities
        .filter((a: any) => a.from?.role === "bot" && a.type === "message")
        .shift();
      if (botMsg?.text) {
        reply = botMsg.text;
        break;
      }
    }

    return { content: [{ type: "text", text: reply }] };
  }
);

/* ───── Express + SSE plumbing (unchanged) ──────────────── */
const app = express();
const transports: Record<string, SSEServerTransport> = {};

app.get("/sse", async (req: Request, res: Response) => {
  const host = req.get("host");
  const fullUri = `https://${host}/jokes`;
  const transport = new SSEServerTransport(fullUri, res);

  transports[transport.sessionId] = transport;
  res.on("close", () => delete transports[transport.sessionId]);
  await server.connect(transport);
});

app.post("/jokes", async (req: Request, res: Response) => {
  const transport = transports[req.query.sessionId as string];
  transport
    ? await transport.handlePostMessage(req, res)
    : res.status(400).send("No transport found for sessionId");
});

app.get("/", (_req, res) => res.send("The Jokes MCP server is running!"));

/* ───── Start HTTP server ───────────────────────────────── */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
