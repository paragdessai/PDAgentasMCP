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
/*                          MCP SERVER SETUP                           */
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
  if (!r.ok) throw new Error(`Chuck API ${r.status}`);
  const d = await r.json();
  return { content: [{ type: "text", text: d.value }] };
});

const getChuckJokeByCategory = server.tool(
  "get-chuck-joke-by-category",
  "Get a random Chuck Norris joke by category",
  { category: z.string().describe("Category of the Chuck Norris joke") },
  async ({ category }) => {
    const r = await fetch(
      `https://api.chucknorris.io/jokes/random?category=${category}`
    );
    if (!r.ok) throw new Error(`Chuck API ${r.status}`);
    const d = await r.json();
    return { content: [{ type: "text", text: d.value }] };
  }
);

const getChuckCategories = server.tool(
  "get-chuck-categories",
  "Get all available categories for Chuck Norris jokes",
  async () => {
    const r = await fetch("https://api.chucknorris.io/jokes/categories");
    if (!r.ok) throw new Error(`Chuck API ${r.status}`);
    const d = await r.json();
    return { content: [{ type: "text", text: d.join(", ") }] };
  }
);

const getDadJoke = server.tool("get-dad-joke", "Get a random dad joke", async () => {
  const r = await fetch("https://icanhazdadjoke.com/", {
    headers: { Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`DadJoke API ${r.status}`);
  const d = await r.json();
  return { content: [{ type: "text", text: d.joke }] };
});

/* ------------------------------------------------------------------ */
/*      NEW  ask-powerplatform-docs  TOOL  (Direct Line)               */
/* ------------------------------------------------------------------ */

const directLineSecret =
  "G77BhCQohDYYnuyjFlo8dfXYs9Szf4UhJKf15T0ZwqHBva3AVF1SJQQJ99BFACYeBjFAArohAAABAZBS1ZXz.7bP9jumoJLViFLPxzlx2gJR92XAvUC2K4fTY7M4Qyn0YWBzrDv8rJQQJ99BFACYeBjFAArohAAABAZBS45oY"; // hard-coded secret

async function pollForReply(
  conversationId: string,
  watermark: string | undefined
): Promise<{ text?: string; attachments?: any[]; newWatermark: string } | null> {
  const url =
    `https://directline.botframework.com/v3/directline/conversations/${conversationId}/activities` +
    (watermark ? `?watermark=${watermark as string}` : "");   // ← cast fixes TS2345

  const poll = await fetch(url, {
    headers: { Authorization: `Bearer ${directLineSecret}` },
  });
  if (!poll.ok) throw new Error(`Poll ${poll.status}`);
  const data = await poll.json();
  console.log("🔎 activities:", JSON.stringify(data.activities, null, 2));
  const botMsgs = data.activities.filter(
    (a: any) => a.from?.id !== "mcp-tool"
  );
  if (botMsgs.length) {
    const last = botMsgs.pop();
    return {
      text: last.text,
      attachments: last.attachments,
      newWatermark: data.watermark,
    };
  }
  return null;
}

const askPowerPlatformDocs = server.tool(
  "ask-powerplatform-docs",
  "Ask the Power Platform documentation Copilot agent (multi-turn supported)",
  {
    text: z.string().describe("Question for the documentation agent"),
    conversationId: z
      .string()
      .optional()
      .describe("Direct Line conversationId for follow-up turns"),
  },
  async ({ text, conversationId }) => {
    let convoId = conversationId;
    let watermark: string | undefined;

    try {
      if (!convoId) {
        const rc = await fetch(
          "https://directline.botframework.com/v3/directline/conversations",
          { method: "POST", headers: { Authorization: `Bearer ${directLineSecret}` } }
        );
        if (!rc.ok) throw new Error(`StartConv ${rc.status}`);
        const d = await rc.json();
        convoId = d.conversationId;
        watermark = d.watermark;
      }

      const post = await fetch(
        `https://directline.botframework.com/v3/directline/conversations/${convoId}/activities`,
        {
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
        }
      );
      if (!post.ok) throw new Error(`PostMsg ${post.status}`);

      let reply = null;
      for (let i = 0; i < 10 && !reply; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        reply = await pollForReply(convoId, watermark);
        if (reply) watermark = reply.newWatermark;
      }

      const replyText =
        reply?.text ||
        (reply?.attachments ? "[Got an attachment reply]" : undefined) ||
        "[No reply from documentation agent]";

      return {
        content: [{ type: "text", text: replyText }],
        metadata: { conversationId: convoId },
      };
    } catch (err: any) {
      console.error("Direct Line failure:", err);
      return {
        content: [
          {
            type: "text",
            text: "❌ Error contacting documentation agent.",
          },
        ],
      };
    }
  }
);

/* ------------------------------------------------------------------ */
/*           EXPRESS  +  STREAMABLE HTTP MCP TRANSPORT                 */
/* ------------------------------------------------------------------ */

const app = express();
app.use(express.json());

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
});
const setupServer = () => server.connect(transport);

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

app.post("/mcp", async (req: Request, res: Response) => {
  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP handler error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

/* ------------------------------------------------------------------ */

const PORT = process.env.PORT || 3000;
setupServer()
  .then(() =>
    app.listen(PORT, () =>
      console.log(`MCP Streamable HTTP Server running on port ${PORT}`)
    )
  )
  .catch((err) => {
    console.error("Failed to start MCP server:", err);
    process.exit(1);
  });
