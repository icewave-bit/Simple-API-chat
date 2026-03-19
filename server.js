require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");

const app = express();

const PORT = Number(process.env.PORT || 3005);
const AI_API_KEY = process.env.AI_API_KEY;
const AI_MODEL = process.env.AI_MODEL || "openai/gpt-4o-mini";
const AI_API_URL = process.env.AI_API_URL || "https://api.vsellm.ru/v1/chat/completions";
const STORE_DIR = path.join(__dirname, "data");
const STORE_FILE = path.join(STORE_DIR, "chat-store.json");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const defaultStore = () => ({
  activeMessages: [],
  archivedChats: [],
});

const normalizeStore = (rawValue) => {
  const base = defaultStore();

  if (!rawValue || typeof rawValue !== "object") {
    return base;
  }

  return {
    activeMessages: Array.isArray(rawValue.activeMessages) ? rawValue.activeMessages : [],
    archivedChats: Array.isArray(rawValue.archivedChats) ? rawValue.archivedChats : [],
  };
};

const ensureStoreFile = async () => {
  await fsp.mkdir(STORE_DIR, { recursive: true });

  if (!fs.existsSync(STORE_FILE)) {
    await fsp.writeFile(STORE_FILE, JSON.stringify(defaultStore(), null, 2), "utf8");
  }
};

const readStore = async () => {
  await ensureStoreFile();
  const content = await fsp.readFile(STORE_FILE, "utf8");
  return normalizeStore(JSON.parse(content));
};

const writeStore = async (store) => {
  await ensureStoreFile();
  await fsp.writeFile(STORE_FILE, JSON.stringify(normalizeStore(store), null, 2), "utf8");
};

const toAIMessage = (message) => ({
  role: message.role,
  content: message.content,
});

const nowIso = () => new Date().toISOString();

const buildArchivedChat = (messages) => {
  const firstUserMessage = messages.find((message) => message.role === "user");
  const titleSource = firstUserMessage?.content || "Archived chat";
  const title = titleSource.length > 60 ? `${titleSource.slice(0, 57)}...` : titleSource;

  return {
    id: crypto.randomUUID(),
    title,
    createdAt: nowIso(),
    messages,
  };
};

app.get("/api/chat/state", async (_, res) => {
  try {
    const store = await readStore();
    return res.json(store);
  } catch (error) {
    console.error("Read state error:", error);
    return res.status(500).json({ error: "Failed to load chat state." });
  }
});

app.post("/api/chat", async (req, res) => {
  if (!AI_API_KEY) {
    return res.status(500).json({
      error: "Missing AI_API_KEY. Add it to your .env file.",
    });
  }

  const userMessage = typeof req.body?.message === "string" ? req.body.message.trim() : "";

  if (!userMessage) {
    return res.status(400).json({ error: "Message is required." });
  }

  try {
    const store = await readStore();
    const userEntry = { role: "user", content: userMessage, createdAt: nowIso() };
    const messagesForModel = [
      {
        role: "system",
        content: "You are a concise, friendly assistant in a web chat app. Keep answers clear and helpful.",
      },
      ...store.activeMessages.map(toAIMessage),
      toAIMessage(userEntry),
    ];

    const response = await fetch(AI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: messagesForModel,
        temperature: 0.7,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      const apiError = data?.error?.message || "AI API request failed.";
      return res.status(response.status).json({ error: apiError });
    }

    const assistantReply = data?.choices?.[0]?.message?.content?.trim();

    if (!assistantReply) {
      return res.status(502).json({ error: "AI API returned an empty response." });
    }

    const assistantEntry = { role: "assistant", content: assistantReply, createdAt: nowIso() };
    const updatedStore = {
      ...store,
      activeMessages: [...store.activeMessages, userEntry, assistantEntry],
    };
    await writeStore(updatedStore);

    return res.json({
      reply: assistantReply,
      state: updatedStore,
    });
  } catch (error) {
    console.error("Chat API error:", error);
    return res.status(500).json({ error: "Server failed to process request." });
  }
});

app.post("/api/chat/archive", async (_, res) => {
  try {
    const store = await readStore();

    if (store.activeMessages.length === 0) {
      return res.json(store);
    }
    const archivedChat = buildArchivedChat(store.activeMessages);

    const updatedStore = {
      activeMessages: [],
      archivedChats: [archivedChat, ...store.archivedChats],
    };

    await writeStore(updatedStore);
    return res.json(updatedStore);
  } catch (error) {
    console.error("Archive chat error:", error);
    return res.status(500).json({ error: "Failed to archive chat." });
  }
});

app.post("/api/chat/open", async (req, res) => {
  const chatId = typeof req.body?.chatId === "string" ? req.body.chatId : "";

  if (!chatId) {
    return res.status(400).json({ error: "chatId is required." });
  }

  try {
    const store = await readStore();
    const targetIndex = store.archivedChats.findIndex((chat) => chat.id === chatId);

    if (targetIndex < 0) {
      return res.status(404).json({ error: "Chat not found." });
    }

    const targetChat = store.archivedChats[targetIndex];
    const remainingArchived = store.archivedChats.filter((chat) => chat.id !== chatId);
    const archivedFromCurrent = store.activeMessages.length > 0 ? buildArchivedChat(store.activeMessages) : null;

    const updatedStore = {
      activeMessages: Array.isArray(targetChat.messages) ? targetChat.messages : [],
      archivedChats: archivedFromCurrent
        ? [archivedFromCurrent, ...remainingArchived]
        : remainingArchived,
    };

    await writeStore(updatedStore);
    return res.json(updatedStore);
  } catch (error) {
    console.error("Open chat error:", error);
    return res.status(500).json({ error: "Failed to open chat." });
  }
});

app.use((_, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const startServer = async () => {
  try {
    await ensureStoreFile();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to initialize chat store:", error);
    process.exit(1);
  }
};

startServer();
