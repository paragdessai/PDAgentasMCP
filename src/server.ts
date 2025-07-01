import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const server = new McpServer({
  name: "jokesMCP",
  description: "A server that provides jokes",
  version: "1.0.0",
  tools: [
    {
      name: "get-chuck-joke",
      description: "Get a random Chuck Norris joke",
      parameters: {},
    },
    {
      name: "get-chuck-categories",
      description: "Get all available categories for Chuck Norris jokes",
      parameters: {},
    },
    {
      name: "get-dad-joke",
      description: "Get a random dad joke",
      parameters: {},
    },
    {
      name: "get-yo-mama-joke",
      description: "Get a random Yo Mama joke",
      parameters: {},
    },
    {
      name: "ask-copilot-agent",
      description: "Ask a Copilot Studio agent using Direct Line. Supports multi-turn.",
      parameters: {
        text: { type: "string", description: "The user input text" },
        conversationId: {
          type: "string",
          description: "Optional conversation ID to maintain multi-turn context",
          optional: true,
        },
      },
    },
  ],
});

// Get Chuck Norris joke tool
const getChuckJoke = server.tool(
  "get-chuck-joke",
  "Get a random Chuck Norris joke",
  async () => {
    const response = await fetch("https://api.chucknorris.io/jokes/random");
    const data = await response.json();
    return {
      content: [
        {
          type: "text",
          text: data.value,
        },
      ],
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
      content: [
        {
          type: "text",
          text: data.join(", "),
        },
      ],
    };
  }
);

// Get Dad joke tool
const getDadJoke = server.tool(
  "get-dad-joke",
  "Get a random dad joke",
  async () => {
    const response = await fetch("https://icanhazdadjoke.com/", {
      headers: {
        Accept: "application/json",
      },
    });
    const data = await response.json();
    return {
      content: [
        {
          type: "text",
          text: data.joke,
        },
      ],
    };
  }
);

// Get Yo Mama joke tool
const getYoMamaJoke = server.tool(
  "get-yo-mama-joke",
  "Get a random Yo Mama joke",
  async () => {
    const response = await fetch("https://www.yomama-jokes.com/api/v1/jokes/random");
    const data = await response.json();
    return {
      content: [
        {
          type: "text",
          text: data.joke,
        },
      ],
    };
  }
);

// Ask Copilot Studio agent tool
const askCopilotAgent = server.tool(
  "ask-copilot-agent",
  "Ask a Copilot Studio agent using Direct Line. Supports multi-turn.",
  {
    text: { type: "string", description: "The user input text" },
    conversationId: {
      type: "string",
      description: "Optional conversation ID to maintain multi-turn context",
      optional: true,
    },
  },
  async ({ text, conversationId }) => {
    const directLineSecret = "G77BhCQohDYYnuyjFlo8dfXYs9Szf4UhJKf15T0ZwqHBva3AVF1SJQQJ99BFACYeBjFAArohAAABAZBS1ZXz.7bP9jumoJLViFLPxzlx2gJR92XAvUC2K4fTY7M4Qyn0YWBzrDv8rJQQJ99BFACYeBjFAArohAAABAZBS45oY"; // 🔁 Replace with actual secret or env var
    let convoId = conversationId;

    try {
      if (!convoId) {
        const convoResp = await fetch(
          "https://directline.botframework.com/v3/directline/conversations",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${directLineSecret}`,
            },
          }
        );
        const convoData = await convoResp.json();
        convoId = convoData.conversationId;
      }

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
            text: text,
          }),
        }
      );

      await new Promise((resolve) => setTimeout(resolve, 1500));

      const activityResp = await fetch(
        `https://directline.botframework.com/v3/directline/conversations/${convoId}/activities`,
        {
          headers: {
            Authorization: `Bearer ${directLineSecret}`,
          },
        }
      );
      const activityData = await activityResp.json();
      const messages = activityData.activities.filter(
        (a: any) => a.from.id !== "mcp-tool"
      );
      const last = messages.pop();

      return {
        content: [
          {
            type: "text",
            text: last?.text || "[No reply from Copilot agent]",
          },
        ],
        metadata: {
          conversationId: convoId,
        },
      };
    } catch (error) {
      console.error("Direct Line error:", error);
      return {
        content: [
          {
            type: "text",
            text: "❌ Error talking to Copilot agent.",
          },
        ],
      };
    }
  }
);

const app = express();

// to support multiple simultaneous connections we have a lookup object from
// sessionId to transport
const transports: { [sessionId: string]: SSEServerTransport } = {};

app.get("/sse", async (req: Request, res: Response) => {
  const host = req.get("host");
  const fullUri = `https://${host}/jokes`;
  const transport = new SSEServerTransport(fullUri, res);
  transports[transport.sessionId] = transport;

  res.on("close", () => {
    delete transports[transport.sessionId];
  });

  await server.connect(transport);
});

app.post("/jokes", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports[sessionId];
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send("No transport found for sessionId");
  }
});

app.get("/", (_req, res) => {
  res.send("The Jokes MCP server is running!");
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Server is running at http://localhost:${PORT}`);
});
