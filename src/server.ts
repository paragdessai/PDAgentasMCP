/**********************************************************************
 * Jokes + Copilot MCP Server  v1.4.1
 * ────────────────────────────────────────────────────────────────────
 * • Four public joke endpoints
 * • POST /copilot  – multi-turn bridge to Copilot Studio (60-s wait)
 * • Same four jokes + copilot proxy are also registered as MCP tools
 *********************************************************************/

import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

/* ─────────── Configuration ─────────────────────────────────────── */
const DIRECT_LINE_SECRET = "G77BhCQohDYYnuyjFlo8dfXYs9Szf4UhJKf15T0ZwqHBva3AVF1SJQQJ99BFACYeBjFAArohAAABAZBS1ZXz.7bP9jumoJLViFLPxzlx2gJR92XAvUC2K4fTY7M4Qyn0YWBzrDv8rJQQJ99BFACYeBjFAArohAAABAZBS45oY";   // ← replace

/* ─────────── Joke helper fetchers ─────────────────────────────── */
const fetchChuckJoke       = async () => fetch("https://api.chucknorris.io/jokes/random")
                                          .then(r => r.json()).then(d => d.value);

const fetchChuckCategories = async () => fetch("https://api.chucknorris.io/jokes/categories")
                                          .then(r => r.json());

const fetchDadJoke         = async () => fetch("https://icanhazdadjoke.com/",
                                          { headers:{Accept:"application/json"} })
                                          .then(r => r.json()).then(d => d.joke);

const fetchYoMamaJoke      = async () => fetch("https://www.yomama-jokes.com/api/v1/jokes/random")
                                          .then(r => r.json()).then(d => d.joke);

/* ─────────── MCP Server Manifest ──────────────────────────────── */
const server = new McpServer({
  name: "jokesMCP",
  description: "Joke utilities + Copilot Studio proxy",
  version: "1.4.1",
  tools: [
    { name: "get-chuck-joke",       description: "Random Chuck Norris joke", parameters: {} },
    { name: "get-chuck-categories", description: "List Chuck categories",     parameters: {} },
    { name: "get-dad-joke",         description: "Random Dad joke",           parameters: {} },
    { name: "get-yo-mama-joke",     description: "Random Yo-Mama joke",       parameters: {} },
    {
      name: "ask-copilot-agent",
      description: "Forward prompt to Copilot Studio (multi-turn)",
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

/* Register helpers as MCP tools */
server.tool("get-chuck-joke",       "", async () => ({ content:[{type:"text",text: await fetchChuckJoke()}] }));
server.tool("get-chuck-categories", "", async () => ({ content:[{type:"text",text:(await fetchChuckCategories()).join(", ")}] }));
server.tool("get-dad-joke",         "", async () => ({ content:[{type:"text",text: await fetchDadJoke()}] }));
server.tool("get-yo-mama-joke",     "", async () => ({ content:[{type:"text",text: await fetchYoMamaJoke()}] }));

/* ─────────── Express app & public REST routes ─────────────────── */
const app = express();

/* GET /jokes/chuck */
app.get("/jokes/chuck", async (_req, res) => {
  res.json({ joke: await fetchChuckJoke() });
});

/* GET /jokes/chuck/categories */
app.get("/jokes/chuck/categories", async (_req, res) => {
  res.json({ categories: await fetchChuckCategories() });
});

/* GET /jokes/dad */
app.get("/jokes/dad", async (_req, res) => {
  res.json({ joke: await fetchDadJoke() });
});

/* GET /jokes/yo-mama */
app.get("/jokes/yo-mama", async (_req, res) => {
  res.json({ joke: await fetchYoMamaJoke() });
});

/* POST /copilot  (multi-turn, waits up to 60 s) */
app.use(express.json());
app.post("/copilot", async (req: Request, res: Response) => {
  const prompt         = req.body?.prompt ?? "";
  let   conversationId = req.body?.conversationId as string | undefined;

  const DL = "https://directline.botframework.com/v3/directline";

  /* 1️⃣ ensure conversation */
  if (!conversationId) {
    const conv = await fetch(`${DL}/conversations`, {
      method:"POST",
      headers:{ Authorization:`Bearer ${DIRECT_LINE_SECRET}` }
    }).then(r => r.json());
    conversationId = conv.conversationId;
  }

  /* 2️⃣ post user message */
  await fetch(`${DL}/conversations/${conversationId}/activities`, {
    method:"POST",
    headers:{
      Authorization:`Bearer ${DIRECT_LINE_SECRET}`,
      "Content-Type":"application/json"
    },
    body: JSON.stringify({
      type:"message",
      from:{ id:"mcp-user" },
      text: prompt
    })
  });

  /* 3️⃣ poll up to 60 s */
  const wait = (ms:number)=>new Promise(r=>setTimeout(r,ms));
  let replyText = "The agent didn’t respond in time.";
  let watermark: string|undefined;

  for (let i=0; i<60; i++) {
    await wait(1000);
    const url = new URL(`${DL}/conversations/${conversationId}/activities`);
    if (watermark) url.searchParams.set("watermark", watermark);

    const { activities, watermark: wm } = await fetch(url, {
      headers:{ Authorization:`Bearer ${DIRECT_LINE_SECRET}` }
    }).then(r=>r.json());

    watermark = wm;
    const botMsg = activities
      .filter((a:any)=>a.from?.role==="bot" && a.type==="message")
      .shift();
    if (botMsg?.text) { replyText = botMsg.text; break; }
  }

  /* 4️⃣ return */
  res.json({
    content:[{type:"text",text:replyText}],
    conversationId
  });
});

/* ─────────── SSE plumbing (unchanged) ────────────────────── */
const transports: Record<string, SSEServerTransport> = {};

app.get("/sse", async (req: Request, res: Response) => {
  const host      = req.get("host");
  const fullUri   = `https://${host}/jokes`;
  const transport = new SSEServerTransport(fullUri, res);

  transports[transport.sessionId] = transport;
  res.on("close", () => delete transports[transport.sessionId]);

  await server.connect(transport);
});

app.post("/jokes", async (req: Request, res: Response) => {
  const transport = transports[req.query.sessionId as string];
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send("No transport found for sessionId");
  }
});

/* Health ping */
app.get("/", (_req, res) => {
  res.send("The Jokes MCP server is running!");
});

/* ─────────── Start HTTP server ───────────────────────────── */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () =>
  console.log(`✅ Server running on http://localhost:${PORT}`)
);
