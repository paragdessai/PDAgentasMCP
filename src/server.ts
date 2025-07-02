/**********************************************************************
 * Jokes + Copilot MCP Server  v1.3.1
 * ────────────────────────────────────────────────────────────────────
 * • Four joke tools
 * • ask-copilot-agent: optional prompt + optional conversationId
 *   – waits up to 60 s for the first bot reply
 *   – returns the active conversationId for multi-turn chat
 *********************************************************************/

import express, {
  Request,
  Response,
  RequestHandler
} from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

/* ─────── Hard-coded Direct Line secret (replace) ────────── */
const DIRECT_LINE_SECRET = "YOUR_DIRECT_LINE_SECRET_HERE";

/* ─────── MCP server manifest ────────────────────────────── */
const server = new McpServer({
  name: "jokesMCP",
  description: "Provides jokes and can query a Copilot Studio agent",
  version: "1.3.1",
  tools: [
    { name: "get-chuck-joke",       description: "Random Chuck Norris joke", parameters: {} },
    { name: "get-chuck-categories", description: "Available Chuck categories", parameters: {} },
    { name: "get-dad-joke",         description: "Random dad joke",            parameters: {} },
    { name: "get-yo-mama-joke",     description: "Random Yo-Mama joke",         parameters: {} },
    {
      name: "ask-copilot-agent",
      description: "Forward a prompt to the Copilot Studio agent (multi-turn-enabled)",
      parameters: {
        type: "object",
        properties: {
          prompt:         { type: "string" },
          conversationId: { type: "string" }
        }
      }
    }
  ],
});

/* ─────── Joke tools (unchanged) ─────────────────────────── */
server.tool("get-chuck-joke", "", async () => {
  const d = await fetch("https://api.chucknorris.io/jokes/random").then(r => r.json());
  return { content: [{ type: "text", text: d.value }] };
});
server.tool("get-chuck-categories", "", async () => {
  const d = await fetch("https://api.chucknorris.io/jokes/categories").then(r => r.json());
  return { content: [{ type: "text", text: d.join(", ") }] };
});
server.tool("get-dad-joke", "", async () => {
  const d = await fetch("https://icanhazdadjoke.com/", { headers: { Accept: "application/json" } }).then(r => r.json());
  return { content: [{ type: "text", text: d.joke }] };
});
server.tool("get-yo-mama-joke", "", async () => {
  const d = await fetch("https://www.yomama-jokes.com/api/v1/jokes/random").then(r => r.json());
  return { content: [{ type: "text", text: d.joke }] };
});

/* ─────── ask-copilot-agent (prompt + multi-turn) ────────── */
server.tool(
  "ask-copilot-agent",
  {                                // ← Zod schema (all optional)
    prompt: z.string().optional(),
    conversationId: z.string().optional()
  },
  async (
    { prompt, conversationId }: { prompt?: string; conversationId?: string }
  ) => {

    const DL = "https://directline.botframework.com/v3/directline";
    const userText = prompt ?? "";

    /* 1️⃣  Ensure a conversation exists */
    if (!conversationId) {
      const conv = await fetch(`${DL}/conversations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${DIRECT_LINE_SECRET}` }
      }).then(r => r.json());
      conversationId = conv.conversationId;
    }

    /* 2️⃣  Post user message (even empty keeps turn order) */
    await fetch(`${DL}/conversations/${conversationId}/activities`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DIRECT_LINE_SECRET}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        type: "message",
        from: { id: "mcp-user" },
        text: userText
      })
    });

    /* 3️⃣  Poll up to 60 s for first bot reply */
    const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
    let reply = "The agent didn’t respond in time.";
    let watermark: string | undefined;

    for (let i = 0; i < 60; i++) {           // 60 × 1 s = 60 s
      await wait(1000);

      const url = new URL(
        `${DL}/conversations/${conversationId}/activities`
      );
      if (watermark) url.searchParams.set("watermark", watermark);

      const { activities, watermark: wm } = await fetch(url, {
        headers: { Authorization: `Bearer ${DIRECT_LINE_SECRET}` }
      }).then(r => r.json());

      watermark = wm;                         // advance watermark

      const botMsg = activities
        .filter((a: any) => a.from?.role === "bot" && a.type === "message")
        .shift();
      if (botMsg?.text) {
        reply = botMsg.text;
        break;
      }
    }

    /* 4️⃣  Return reply **and** conversationId */
    return {
      content: [{ type: "text", text: reply }],
      _meta: { conversationId },             // MCP-style metadata
      conversationId                         // easy access for connector
    };
  }
);

/* ─────── Express + SSE plumbing ─────────────────────────── */
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

/* ─────── Health endpoint ────────────────────────────────── */
const rootHandler: RequestHandler = (_req, res) =>
  res.send("The Jokes MCP server is running!");
app.get("/", rootHandler);

/* ─────── Start HTTP server ─────────────────────────────── */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () =>
  console.log(`✅ Server running on http://localhost:${PORT}`)
);
