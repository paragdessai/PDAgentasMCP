import express, {
  Request,
  Response,
  RequestHandler,
  NextFunction,
} from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/* ------------------------------------------------------------------ */
/*                       MCP SERVER INITIALISE                         */
/* ------------------------------------------------------------------ */

const server = new McpServer({
  name: "mcp-streamable-http",
  version: "1.0.0",
});

/* ------------------------------------------------------------------ */
/*                              JOKE TOOLS                             */
/* ------------------------------------------------------------------ */

const getChuckJoke = server.tool("get-chuck-joke", "Get a random Chuck Norris joke", async () => {
  const r = await fetch("https://api.chucknorris.io/jokes/random");
  const d = await r.json();
  return { content: [{ type: "text", text: d.value }] };
});

const getChuckJokeByCategory = server.tool(
  "get-chuck-joke-by-category",
  "Get a random Chuck Norris joke by category",
  { category: z.string() },
  async ({ category }) => {
    const r = await fetch(
      `https://api.chucknorris.io/jokes/random?category=${category}`
    );
    const d = await r.json();
    return { content: [{ type: "text", text: d.value }] };
  }
);

const getChuckCategories = server.tool(
  "get-chuck-categories",
  "Get all available categories for Chuck Norris jokes",
  async () => {
    const r = await fetch("https://api.chucknorris.io/jokes/categories");
    const d = await r.json();
    return { content: [{ type: "text", text: d.join(", ") }] };
  }
);

const getDadJoke = server.tool("get-dad-joke", "Get a random dad joke", async () => {
  const r = await fetch("https://icanhazdadjoke.com/", {
    headers: { Accept: "application/json" },
  });
  const d = await r.json();
  return { content: [{ type: "text", text: d.joke }] };
});

/* ------------------------------------------------------------------ */
/*              POWER PLATFORM DOCS AGENT (DIRECT LINE)                */
/* ------------------------------------------------------------------ */

const directLineSecret =
  "G77BhCQohDYYnuyjFlo8dfXYs9Szf4UhJKf15T0ZwqHBva3AVF1SJQQJ99BFACYeBjFAArohAAABAZBS1ZXz.7bP9jumoJLViFLPxzlx2gJR92XAvUC2K4fTY7M4Qyn0YWBzrDv8rJQQJ99BFACYeBjFAArohAAABAZBS45oY";

const buildActivitiesUrl = (conversationId: string, watermark?: string) =>
  watermark
    ? `https://directline.botframework.com/v3/directline/conversations/${conversationId}/activities?watermark=${encodeURIComponent(
        watermark
      )}`
    : `https://directline.botframework.com/v3/directline/conversations/${conversationId}/activities`;

async function pollForReply(
  conversationId: string,
  watermark: string | undefined
) {
  const poll = await fetch(buildActivitiesUrl(conversationId, watermark), {
    headers: { Authorization: `Bearer ${directLineSecret}` },
  });
  const data = await poll.json();
  const botMsgs = data.activities.filter(
    (a: any) => a.from?.id !== "mcp-tool"
  );
  if (botMsgs.length) {
    const last = botMsgs.pop();
    return { last, watermark: data.watermark };
  }
  return null;
}

const askPowerPlatformDocs = server.tool(
  "ask-powerplatform-docs",
  "Ask the Power Platform documentation Copilot agent (multi-turn supported)",
  {
    text: z.string(),
    conversationId: z.string().optional(),
  },
  async ({ text, conversationId }) => {
    let convoId: string | undefined = conversationId;
    let watermark: string | undefined;

    try {
      if (!convoId) {
        const c = await fetch(
          "https://directline.botframework.com/v3/directline/conversations",
          { method: "POST", headers: { Authorization: `Bearer ${directLineSecret}` } }
        );
        const d = await c.json();
        convoId = d.conversationId;
        watermark = d.watermark;
      }

      /*  assure TypeScript convoId is string from this point  */
      const cid = convoId!;

      await fetch(buildActivitiesUrl(cid), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${directLineSecret}`,
        },
        body: JSON.stringify({
          type: "message",
          from: { id: "mcp-tool" },
          text,
        }),
      });

      let reply = null;
      for (let i = 0; i < 10 && !reply; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        reply = await pollForReply(cid, watermark);
        if (reply) watermark = reply.watermark;
      }

      const replyText =
        reply?.last?.text ||
        (reply?.last?.attachments ? "[Attachment reply]" : "[No reply]");

      return {
        content: [{ type: "text", text: replyText }],
        metadata: { conversationId: cid },
      };
    } catch (err) {
      console.error("Direct Line error", err);
      return {
        content: [{ type: "text", text: "❌ Error contacting documentation agent." }],
      };
    }
  }
);

/* ------------------------------------------------------------------ */
/*                    EXPRESS + MCP TRANSPORT                          */
/* ------------------------------------------------------------------ */

const app = express();
app.use(express.json());

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
});
server.connect(transport);

const methodNotAllowed: RequestHandler = (
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
};

app.post("/mcp", (req, res) => transport.handleRequest(req, res, req.body));
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ MCP Streamable HTTP Server running on port ${PORT}`)
);
