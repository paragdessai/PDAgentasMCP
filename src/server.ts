import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import axios from "axios";

// 🔐 Direct Line Secret (FOR TESTING ONLY — DO NOT COMMIT TO PUBLIC REPO)
const DIRECT_LINE_SECRET = "YOUR_DIRECT_LINE_SECRET_HERE"; // Replace with your actual secret

if (!DIRECT_LINE_SECRET) {
  console.error("❌ DIRECT_LINE_SECRET is missing.");
  process.exit(1);
}

const server = new McpServer({
  name: "mcp-streamable-http",
  version: "1.0.0",
});

// Example tool: Ask Copilot Studio agent via Direct Line
const askCopilotAgent = server.tool(
  "ask-copilot-agent",
  "Ask a Copilot Studio agent using Direct Line. Supports multi-turn conversations.",
  {
    text: z.string().describe("User question to the Copilot Studio agent"),
    conversationId: z.string().optional().describe("Optional conversation ID for multi-turn context"),
  },
  async (params: { text: string; conversationId?: string }) => {
    const { text, conversationId } = params;

    try {
      let convoId = conversationId;

      // Start new conversation if needed
      if (!convoId) {
        const convoResp = await axios.post(
          "https://directline.botframework.com/v3/directline/conversations",
          {},
          {
            headers: {
              Authorization: `Bearer ${DIRECT_LINE_SECRET}`,
            },
          }
        );
        convoId = convoResp.data.conversationId;
      }

      // Send message
      await axios.post(
        `https://directline.botframework.com/v3/directline/conversations/${convoId}/activities`,
        {
          type: "message",
          from: { id: "mcp-tool" },
          text,
        },
        {
          headers: {
            Authorization: `Bearer ${DIRECT_LINE_SECRET}`,
          },
        }
      );

      // Delay briefly for bot to respond
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Get latest bot reply
      const activityList = await axios.get(
        `https://directline.botframework.com/v3/directline/conversations/${convoId}/activities`,
        {
          headers: {
            Authorization: `Bearer ${DIRECT_LINE_SECRET}`,
          },
        }
      );

      const activities = activityList.data.activities;
      const botReply = activities
        .filter((a: any) => a.from.id !== "mcp-tool")
        .pop();

      return {
        content: [
          {
            type: "text",
            text: botReply?.text || "[No response from Copilot agent]",
          },
        ],
        metadata: {
          conversationId: convoId,
        },
      };
    } catch (err: any) {
      console.error("❌ Error talking to Copilot Studio agent:", err?.response?.data || err.message);
      return {
        content: [
          {
            type: "text",
            text: "⚠️ Failed to contact Copilot Studio agent.",
          },
        ],
      };
    }
  }
);

// Other tools (e.g., jokes) can go here...

const app = express();
app.use(express.json());

const transport: StreamableHTTPServerTransport =
  new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

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
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

app.get("/mcp", async (_req: Request, res: Response) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    })
  );
});

app.delete("/mcp", async (_req: Request, res: Response) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    })
  );
});

const PORT = process.env.PORT || 3000;
setupServer()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 MCP Streamable HTTP Server listening on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to set up the server:", error);
    process.exit(1);
  });
