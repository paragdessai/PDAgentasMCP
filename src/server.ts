/**********************************************************************
 * Jokes + Copilot MCP Server  v1.3.2
 * ────────────────────────────────────────────────────────────────────
 * • Four joke tools
 * • ask-copilot-agent
 *     – optional prompt
 *     – optional conversationId (multi-turn)
 *     – waits up to 60 s for first bot reply
 *     – always returns conversationId in both `_meta` and top level
 *********************************************************************/

import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

/* ─────────── Configuration ─────────────────────────────────────── */
const DIRECT_LINE_SECRET = "G77BhCQohDYYnuyjFlo8dfXYs9Szf4UhJKf15T0ZwqHBva3AVF1SJQQJ99BFACYeBjFAArohAAABAZBS1ZXz.7bP9jumoJLViFLPxzlx2gJR92XAvUC2K4fTY7M4Qyn0YWBzrDv8rJQQJ99BFACYeBjFAArohAAABAZBS45oY";   // ← replace

/* ─────────── MCP Server Manifest ──────────────────────────────── */
const server = new McpServer({
  name: "jokesMCP",
  description: "Provides jokes and can query a Copilot Studio agent",
  version: "1.3.2",
  tools: [
    { name: "get-chuck-joke",       description: "Random Chuck Norris joke", parameters: {} },
    { name: "get-chuck-categories", description: "Available Chuck categories", parameters: {} },
    { name: "get-dad-joke",         description: "Random dad joke",            parameters: {} },
    { name: "get-yo-mama-joke",     description: "Random Yo-Mama joke",         parameters: {} },
    {
      name: "ask-copilot-agent",
      description: "Forward a prompt to the Copilot Studio agent (multi-turn)",
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

/* ─────────── Joke Tools ───────────────────────────────────────── */

server.tool("get-chuck-joke", "", async () => {
  const { value } = await fetch("https://api.chucknorris.io/jokes/random").then(r => r.json());
  return { content: [{ type: "text", text: value }] };
});

server.tool("get-chuck-categories", "", async () => {
  const categories = await fetch("https://api.chucknorris.io/jokes/categories").then(r => r.json());
  return { content: [{ type: "text", text: categories.join(", ") }] };
});

server.tool("get-dad-joke", "", async () => {
  const { joke } = await fetch("https://icanhazdadjoke.com/", { headers: { Accept: "application/json" } }).then(r => r.json());
  return { content: [{ type: "text", text: joke }] };
});

server.tool("get-yo-mama-joke", "", async () => {
  const { joke } = await fetch("https://www.yomama-jokes.com/api/v1/jokes/random").then(r => r.json());
  return { content: [{ type: "text", text: joke }] };
});

/* ─────────── ask-copilot-agent (multi-turn, 60 s wait) ────────── */

server.tool(
  "ask-copilot-agent",
  {
    prompt: z.string().optional(),
    conversationId: z.string().optional()
  },
  async ({ prompt, conversationId }: { prompt?: string; conversationId?: string }) => {
    const userText = prompt ?? "";
    const DL = "https://directline.botframework.com/v3/directline";

    /* 1️⃣ Ensure a Direct Line conversation exists */
    if (!conversationId) {
      const conv = await fetch(`${DL}/conversations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${DIRECT_LINE_SECRET}` }
      }).then(r => r.json());
      conversationId = conv.conversationId;
    }

    /* 2️⃣ Post the user message (even if empty) */
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

    /* 3️⃣ Poll up to 60 s (1 s intervals) for first bot reply */
    const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
    let replyText = "The agent didn’t respond in time.";
    let watermark: string | undefined;

    for (let i = 0; i < 60; i++) {
      await wait(1000);

      const url = new URL(`${DL}/conversations/${conversationId}/activities`);
      if (watermark) url.searchParams.set("watermark", watermark);

      const { activities, watermark: wm } = await fetch(url, {
        headers: { Authorization: `Bearer ${DIRECT_LINE_SECRET}` }
      }).then(r => r.json());

      watermark = wm;

      const botMsg = activities
        .filter((a: any) => a.from?.role === "bot" && a.type === "message")
        .shift();
      if (botMsg?.text) {
        replyText = botMsg.text;
        break;
      }
    }

    /* 4️⃣ Return reply plus conversationId for next turn */
    return {
      content: [{ type: "text", text: replyText }],
      conversationId,            // easy access for caller
      _meta: { conversationId }  // MCP-style metadata
    };
  }
);

/* ─────────── Express / SSE plumbing ─────────────────────────── */

const app = express();
const transports: Record<string, SSEServerTransport> = {};

/* SSE endpoint */
app.get("/sse", async (req: Request, res: Response) => {
  const host = req.get("host");
  const fullUri = `https://${host}/jokes`;
  const transport = new SSEServerTransport(fullUri, res);

  transports[transport.sessionId] = transport;
  res.on("close", () => delete transports[transport.sessionId]);

  await server.connect(transport);
});

/* Messages endpoint */
app.post("/jokes", async (req: Request, res: Response) => {
  const transport = transports[req.query.sessionId as string];
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send("No transport found for sessionId");
  }
});

/* Health endpoint (returns void, satisfies TS) */
app.get("/", (_req, res) => {
  res.send("The Jokes MCP server is running!");
});

/* ─────────── Start HTTP server ─────────────────────────────── */

const PORT = process.env.PORT || 3001;
app.listen(PORT, () =>
  console.log(`✅ Server running on http://localhost:${PORT}`)
);
