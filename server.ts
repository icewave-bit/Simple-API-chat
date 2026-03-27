import "dotenv/config";
import express, { type Request, type Response } from "express";
import path from "path";
import crypto from "crypto";

type ChatRole = "user" | "assistant" | "system";

type ChatMessage = {
  role: ChatRole;
  content: string;
  createdAt: string;
};

type ArchivedChat = {
  id: string;
  title: string;
  createdAt: string;
  messages: ChatMessage[];
};

type ChatState = {
  activeMessages: ChatMessage[];
  archivedChats: ArchivedChat[];
};

type ChatStateRequest = { state: ChatState };
/** Used when the client sends an empty `systemPrompt`. */
const DEFAULT_SYSTEM_PROMPT =
  "You are a concise, friendly assistant in a web chat app. Keep answers clear and helpful.";

type ChatSendRequest = {
  apiKey: string;
  message: string;
  state: ChatState;
  model?: string;
  /** Overrides DEFAULT_SYSTEM_PROMPT when non-empty after trim. */
  systemPrompt?: string;
};
type ChatOpenRequest = { chatId: string; state: ChatState };

const app = express();

const PORT = Number(process.env.PORT || 3005);
const AI_API_URL =
  process.env.AI_API_URL || "https://api.vsellm.ru/v1/chat/completions";

const PROJECT_ROOT = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

const ALLOWED_ROLES: readonly ChatRole[] = ["user", "assistant", "system"];
const isChatRole = (value: unknown): value is ChatRole =>
  ALLOWED_ROLES.includes(value as ChatRole);

const parseChatMessage = (raw: unknown): ChatMessage | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as any;

  if (!isChatRole(r.role)) return null;
  if (typeof r.content !== "string") return null;
  if (typeof r.createdAt !== "string") return null;

  return {
    role: r.role,
    content: r.content,
    createdAt: r.createdAt,
  };
};

const parseArchivedChat = (raw: unknown): ArchivedChat | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as any;

  if (typeof r.id !== "string") return null;
  if (typeof r.title !== "string") return null;
  if (typeof r.createdAt !== "string") return null;
  if (!Array.isArray(r.messages)) return null;

  const messages: ChatMessage[] = [];
  for (const m of r.messages) {
    const parsed = parseChatMessage(m);
    if (!parsed) return null;
    messages.push(parsed);
  }

  return { id: r.id, title: r.title, createdAt: r.createdAt, messages };
};

const parseChatState = (raw: unknown): ChatState | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as any;

  if (!Array.isArray(r.activeMessages)) return null;
  if (!Array.isArray(r.archivedChats)) return null;

  const activeMessages: ChatMessage[] = [];
  for (const m of r.activeMessages) {
    const parsed = parseChatMessage(m);
    if (!parsed) return null;
    activeMessages.push(parsed);
  }

  const archivedChats: ArchivedChat[] = [];
  for (const c of r.archivedChats) {
    const parsed = parseArchivedChat(c);
    if (!parsed) return null;
    archivedChats.push(parsed);
  }

  return { activeMessages, archivedChats };
};

const nowIso = () => new Date().toISOString();

const readJsonBody = async (
  upstream: globalThis.Response
): Promise<{ data: unknown | null; raw: string }> => {
  const raw = await upstream.text();
  const trimmed = raw.trim();
  if (!trimmed) return { data: null, raw };
  try {
    return { data: JSON.parse(trimmed) as unknown, raw };
  } catch {
    return { data: null, raw };
  }
};

const upstreamErrorText = (
  data: unknown | null,
  raw: string,
  status: number
): string => {
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    const err = o.error;
    if (err && typeof err === "object") {
      const msg = (err as Record<string, unknown>).message;
      if (typeof msg === "string" && msg.trim()) return msg.trim();
    }
    if (typeof o.message === "string" && o.message.trim()) return o.message.trim();
  }
  const snippet = raw.trim().slice(0, 400).replace(/\s+/g, " ");
  if (snippet) return `Upstream error (${status}): ${snippet}`;
  return `Upstream request failed (${status}).`;
};

/** OpenAI-style chat: `choices[0].message.content` may be a string or a list of parts. */
const extractAssistantText = (data: unknown): string => {
  if (!data || typeof data !== "object") return "";
  const choices = (data as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const choice = choices[0];
  if (!choice || typeof choice !== "object") return "";
  const msg = (choice as Record<string, unknown>).message;
  if (!msg || typeof msg !== "object") return "";
  const text = (msg as Record<string, unknown>).content;
  if (typeof text === "string") return text.trim();
  if (!Array.isArray(text)) return "";

  const parts: string[] = [];
  for (const part of text) {
    if (typeof part === "string") parts.push(part);
    else if (part && typeof part === "object") {
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string") parts.push(p.text);
      else if (typeof p.content === "string") parts.push(p.content);
    }
  }
  return parts.join("").trim();
};

const toAIMessage = (message: ChatMessage) => ({
  role: message.role,
  content: message.content,
});

const buildArchivedChat = (messages: ChatMessage[]): ArchivedChat => {
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

app.post(
  "/api/chat",
  async (req: Request<{}, any, unknown>, res: Response): Promise<Response | void> => {
    const body = req.body as Partial<ChatSendRequest> | undefined;
    const userMessage =
      typeof body?.message === "string" ? body.message.trim() : "";
    const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey) {
      return res.status(400).json({ error: "apiKey is required." });
    }

    const state = parseChatState(body?.state);
    if (!state) {
      return res.status(400).json({ error: "Invalid state." });
    }

    if (!userMessage) {
      return res.status(400).json({ error: "Message is required." });
    }

    const model = typeof body?.model === "string" ? body.model.trim() : "";
    if (!model) {
      return res.status(400).json({
        error: "Model is required. Choose Menu → Settings and enter a model id.",
      });
    }

    const systemPrompt =
      typeof body?.systemPrompt === "string" ? body.systemPrompt.trim() : "";
    const systemContent = systemPrompt || DEFAULT_SYSTEM_PROMPT;

    try {
      const userEntry: ChatMessage = {
        role: "user",
        content: userMessage,
        createdAt: nowIso(),
      };

      const messagesForModel = [
        {
          role: "system" as const,
          content: systemContent,
        },
        ...state.activeMessages.map(toAIMessage),
        toAIMessage(userEntry),
      ];

      const response = await fetch(AI_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: messagesForModel,
          temperature: 0.7,
        }),
      });

      const { data, raw } = await readJsonBody(response);

      if (!response.ok) {
        const apiError = upstreamErrorText(data, raw, response.status);
        const status = response.status >= 400 && response.status < 600 ? response.status : 502;
        return res.status(status).json({ error: apiError });
      }

      if (data === null && raw.trim()) {
        return res.status(502).json({
          error: "AI API returned a non-JSON response.",
        });
      }

      const assistantReply = extractAssistantText(data);

      if (!assistantReply) {
        return res.status(502).json({
          error:
            "AI API returned an empty or unrecognized assistant message. Check model name and response format.",
        });
      }

      const assistantEntry: ChatMessage = {
        role: "assistant",
        content: assistantReply,
        createdAt: nowIso(),
      };

      const updatedState: ChatState = {
        ...state,
        activeMessages: [...state.activeMessages, userEntry, assistantEntry],
      };

      return res.json({
        reply: assistantReply,
        state: updatedState,
      });
    } catch (error) {
      console.error("Chat API error:", error);
      const detail = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({
        error: `Server failed to process request: ${detail}`,
      });
    }
  }
);

app.post(
  "/api/chat/archive",
  async (req: Request<{}, any, unknown>, res: Response): Promise<Response | void> => {
    const body = req.body as Partial<ChatStateRequest> | undefined;

    const state = parseChatState(body?.state);
    if (!state) {
      return res.status(400).json({ error: "Invalid state." });
    }

    try {
      if (state.activeMessages.length === 0) {
        return res.json(state);
      }

      const archivedChat = buildArchivedChat(state.activeMessages);

      const updatedState: ChatState = {
        activeMessages: [],
        archivedChats: [archivedChat, ...state.archivedChats],
      };

      return res.json(updatedState);
    } catch (error) {
      console.error("Archive chat error:", error);
      return res.status(500).json({ error: "Failed to archive chat." });
    }
  }
);

app.post(
  "/api/chat/open",
  async (req: Request<{}, any, unknown>, res: Response): Promise<Response | void> => {
    const body = req.body as Partial<ChatOpenRequest> | undefined;
    const chatId = typeof body?.chatId === "string" ? body.chatId : "";

    const state = parseChatState(body?.state);
    if (!state) {
      return res.status(400).json({ error: "Invalid state." });
    }

    if (!chatId) {
      return res.status(400).json({ error: "chatId is required." });
    }

    try {
      const targetIndex = state.archivedChats.findIndex((chat) => chat.id === chatId);
      if (targetIndex < 0) {
        return res.status(404).json({ error: "Chat not found." });
      }

      const targetChat = state.archivedChats[targetIndex];
      const remainingArchived = state.archivedChats.filter((chat) => chat.id !== chatId);
      const archivedFromCurrent =
        state.activeMessages.length > 0 ? buildArchivedChat(state.activeMessages) : null;

      const updatedState: ChatState = {
        activeMessages: targetChat.messages,
        archivedChats: archivedFromCurrent
          ? [archivedFromCurrent, ...remainingArchived]
          : remainingArchived,
      };

      return res.json(updatedState);
    } catch (error) {
      console.error("Open chat error:", error);
      return res.status(500).json({ error: "Failed to open chat." });
    }
  }
);

// Express 5 doesn't reliably accept `app.get("*")` patterns; use a catch-all middleware.
app.use((_req: Request, res: Response) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

