import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const server = new McpServer({
  name: "mcp-streamable-http",
  version: "1.0.0",
});

/* ------------------------------------------------------------------ */
/*                              JOKE TOOLS                             */
/* ------------------------------------------------------------------ */

// Get Chuck Norris joke tool
const getChuckJoke = server.tool(
  "get-chuck-joke",
  "Get a random Chuck Norris joke",
  async () => {
    const response = await fetch("https://api.chucknorris.io/jokes/random");
    const data = await response.json();
    return {
      content: [{ type: "text", text: data.value }],
    };
  }
);

// Get Chuck Norris joke by category tool
const getChuckJokeByCategory = server.tool(
  "get-chuck-joke-by-category",
  "Get a random Chuck Norris joke by category",
  { category: z.string().describe("Category of the Chuck Norris joke") },
  async ({ category }) => {
    const response = await fetch(
      `https://api.chucknorris.io/jokes/random?category=${category}`
    );
    const data = await response.json();
    return {
      content: [{ type: "text", text: data.value }],
    };
  }
);

// Get Chuck Norris joke categories tool
const getChuckCategories = server.tool(
  "get-chuck-categories",
  "Get all available categories for Chuck Norris jokes",
  async () => {
    const response = await fetch("https://api.chucknorris.io/jokes/categories");
    const data = await response.json();
    return {
      content: [{ type: "text", text: data.join(", ") }],
    };
  }
);

// Get Dad joke tool
const getDadJoke = server.tool(
  "get-dad-joke",
  "Get a random dad joke",
  async () => {
    const response = await fetch("https://icanhazdadjoke.com/", {
      headers: { Accept: "application/json" },
    });
    const data = await response.json();
    return {
      content: [{ type: "text", text: data.joke }],
    };
  }
);

/* ------------------------------------------------------------------ */
/*                NEW POWER PLATFORM DOCS DIRECT-LINE TOOL             */
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
    const directLineSecret = "G77BhCQohDYYnuyjFlo8dfXYs9Szf4UhJKf15T0ZwqHBva3AVF1SJQQJ99BFACYeBjFAArohAAABAZBS1ZXz.7bP9jumoJLViFLPxzlx2gJR92XAvUC2K4fTY7M4Qyn0YWBzrDv8rJQQJ99BFACYeBjFAArohAAABAZBS45oY"; // 🔁 replace or use env var
    let convoId = conversationId;

    try {
      /* 1️⃣  Create a new Direct Line conversation if needed */
      if (!convoId) {
        const convoResp = await fetch(
          "https://directline.botframework.com/v3/directline/conversations",
          {
            method: "POST",
            headers: { Authorization: `Bearer ${directLineSecret}` },
          }
        );
        const convoData = await convoResp.json();
        convoId = convoData.conversationId;
      }

      /* 2️⃣  Post the user's message */
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

      /* 3️⃣  Small delay then fetch bot reply */
      await new Promise((r) => setTimeout(r, 1500));

      const activityResp = await fetch(
        `https://directline.botframework.com/v3/directline/conversations/${convoId}/activities`,
        { headers: { Authorization: `Bearer ${directLineSecret}` } }
      );
      const activityData = await activityResp.json();
      const replies = activityData.activities.filter(
        (a: any) => a.from.id !== "mcp-tool"
      );
      const last = replies.pop();

      /* 4️⃣  Return MCP-formatted result */
      return {
        content: [
          {
            type: "text",
            text: last?.text || "[No reply from documentation agent]",
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
/*                    EXPRESS + MCP TRANSPORT SETUP                    */
/* ------------------------------------------------------------------ */

const app = express();
app.use(express.json());

const transport: StreamableHTTPServerTransport =
  new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

const setupServer = async () => {
  await server.connect(transport);
};

app.post("/mcp", async (req: Request, res: Response) => {
  console.log("Received MCP request:", req.body);
  try {
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req, res) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  })
);

app.delete("/mcp", (_req, res) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  })
);

const PORT = process.env.PORT || 3000;
setupServer()
  .then(() => {
    app.listen(PORT, () =>
      console.log(`MCP Streamable HTTP Server listening on port ${PORT}`)
    );
  })
  .catch((err) => {
    console.error("Failed to set up the server:", err);
    process.exit(1);
  });
