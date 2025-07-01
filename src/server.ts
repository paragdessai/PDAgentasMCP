import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const server = new McpServer({
  name: "mcp-streamable-http",
  version: "1.0.0",
});

/* ------------------------------------------------------------------ */
/*                           JOKE TOOLS                                */
/* ------------------------------------------------------------------ */

const getChuckJoke = server.tool("get-chuck-joke", "Get a random Chuck Norris joke", async () => {
  const r = await fetch("https://api.chucknorris.io/jokes/random");
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
/*         NEW  ask-powerplatform-docs  (Direct Line) TOOL             */
/* ------------------------------------------------------------------ */

const askPowerPlatformDocs = server.tool(
  "ask-powerplatform-docs",
  "Ask the Power Platform documentation Copilot agent (multi-turn supported)",
  {
    text: z.string().describe("Question to ask the documentation agent"),
    conversationId: z
      .string()
      .optional()
      .describe("Optional Direct Line conversation ID for multi-turn chat"),
  },
  async ({ text, conversationId }) => {
    const directLineSecret = "YOUR_DIRECT_LINE_SECRET_HERE"; // ← replace
    let convoId = conversationId;

    try {
      // 1) Start new conversation if none provided
      if (!convoId) {
        const r = await fetch(
          "https://directline.botframework.com/v3/directline/conversations",
          { method: "POST", headers: { Authorization: `Bearer ${directLineSecret}` } }
        );
        const d = await r.json();
        convoId = d.conversationId;
      }

      // 2) Send the user's message
      await fetch(
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

      // 3) Brief pause then fetch bot reply
      await new Promise((r) => setTimeout(r, 1500));
      const ar = await fetch(
        `https://directline.botframework.com/v3/directline/conversations/${convoId}/activities`,
        { headers: { Authorization: `Bearer ${directLineSecret}` } }
      );
      const ad = await ar.json();
      const botMessages = ad.activities.filter(
        (a: any) => a.from.id !== "mcp-tool"
      );
      const last = botMessages.pop();

      return {
        content: [
          {
            type: "text",
            text: last?.text ?? "[No reply from documentation agent]",
          },
        ],
        metadata: { conversationId: convoId },
      };
    } catch (err) {
      console.error("Direct Line error:", err);
      return {
        content: [{ type: "text", text: "❌ Error contacting documentation agent." }],
      };
    }
  }
);

/* ------------------------------------------------------------------ */
/*                     EXPRESS + MCP TRANSPORT                         */
/* ------------------------------------------------------------------ */

const app = express();
app.use(express.json());

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // stateless
});

const setupServer = async () => {
  await server.connect(transport);
};

/* -----  Request-handler for unsupported HTTP verbs  ---------------- */
const methodNotAllowed: RequestHandler = (_req, res, _next: NextFunction) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
};

app.post("/mcp", async (req: Request, res: Response) => {
  console.log("Received MCP request:", req.body);
  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling MCP request:", err);
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
      console.log(`MCP Streamable HTTP Server listening on port ${PORT}`)
    )
  )
  .catch((err) => {
    console.error("Failed to set up the server:", err);
    process.exit(1);
  });
