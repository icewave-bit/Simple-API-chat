import initSqlJs from "sql.js";
import type { ChatMessage, ChatState } from "./chatTypes";
import type { PersistState } from "./state";
import sqlWasmBrowser from "sql.js/dist/sql-wasm-browser.wasm";

const LOCAL_STORAGE_DB_KEY = "ai-chat-db-v1";

// Schema:
// - chats: archived chat metadata
// - messages: messages for both archived chats (chatId=<archivedId>) and active chat (chatId='current')
// - settings: persisted key/value pairs (we store apiKey under key='apiKey')
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  title TEXT,
  createdAt TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  chatId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (chatId, seq)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export type LoadedDb = {
  SQL: any;
  db: any;
};

const encodeBase64 = (bytes: Uint8Array): string => {
  // Convert Uint8Array -> binary string -> base64.
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};

const decodeBase64 = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const loadApiKey = (db: any): string => {
  const result = db.exec(
    "SELECT value FROM settings WHERE key='apiKey' LIMIT 1;"
  ) as undefined | { values: unknown[][] }[];
  const rows = result?.[0]?.values;
  if (!rows || rows.length === 0) return "";
  return String(rows[0]?.[0] ?? "");
};

const loadModel = (db: any): string => {
  const result = db.exec(
    "SELECT value FROM settings WHERE key='aiModel' LIMIT 1;"
  ) as undefined | { values: unknown[][] }[];
  const rows = result?.[0]?.values;
  if (!rows || rows.length === 0) return "";
  return String(rows[0]?.[0] ?? "");
};

const loadChatState = (db: any): ChatState => {
  const activeResult = db.exec(
    "SELECT role, content, createdAt, seq FROM messages WHERE chatId='current' ORDER BY seq ASC;"
  ) as undefined | { values: unknown[][] }[];
  const activeRows = activeResult?.[0]?.values;

  const activeMessages: ChatMessage[] = (activeRows || []).map((r: any[]) => ({
    role: r[0],
    content: r[1],
    createdAt: r[2],
  }));

  const chatResult = db.exec(
    "SELECT id, title, createdAt FROM chats ORDER BY createdAt DESC;"
  ) as undefined | { values: unknown[][] }[];
  const chatRows = chatResult?.[0]?.values;

  const archivedChats = (chatRows || []).map((r: any[]) => {
    const chatId = String(r[0]);
    const title = String(r[1] ?? "Archived chat");
    const createdAt = String(r[2] ?? "");

    const safeChatId = chatId.replaceAll("'", "''");
    const msgResult = db.exec(
      `SELECT role, content, createdAt, seq FROM messages WHERE chatId='${safeChatId}' ORDER BY seq ASC;`
    ) as undefined | { values: unknown[][] }[];
    const msgRows = msgResult?.[0]?.values;

    const messages: ChatMessage[] = (msgRows || []).map((mr: any[]) => ({
      role: mr[0],
      content: mr[1],
      createdAt: mr[2],
    }));

    return { id: chatId, title, createdAt, messages };
  });

  return { activeMessages, archivedChats };
};

export const initLocalDbAndLoad = async (): Promise<{ loaded: PersistState; db: any; SQL: any }> => {
  const storedBase64 = localStorage.getItem(LOCAL_STORAGE_DB_KEY);

  const SQL = await initSqlJs({
    locateFile: (fileName: string) => {
      // `sql.js` calls locateFile('sql-wasm-browser.wasm', ...); we return the bundled URL.
      void fileName;
      return sqlWasmBrowser;
    },
  });

  const db =
    storedBase64 && storedBase64.length > 0
      ? new SQL.Database(decodeBase64(storedBase64))
      : new SQL.Database();

  db.exec(SCHEMA_SQL);

  const apiKey = loadApiKey(db);
  const model = loadModel(db);
  const chatState = loadChatState(db);

  const loaded: PersistState = {
    apiKey,
    model,
    chatState,
  };

  return { loaded, db, SQL };
};

export const savePersistStateToLocalDb = (
  SQL: any,
  db: any,
  persistState: PersistState
): void => {
  db.exec("BEGIN TRANSACTION;");

  // Wipe and reinsert (simple & deterministic for small histories).
  db.exec("DELETE FROM chats;");
  db.exec("DELETE FROM messages;");
  db.exec("DELETE FROM settings WHERE key IN ('apiKey', 'aiModel');");

  if (persistState.apiKey) {
    const escaped = persistState.apiKey.replaceAll("'", "''");
    db.exec(`INSERT INTO settings (key, value) VALUES ('apiKey', '${escaped}');`);
  }

  if (persistState.model.trim()) {
    const escapedModel = persistState.model.replaceAll("'", "''");
    db.exec(`INSERT INTO settings (key, value) VALUES ('aiModel', '${escapedModel}');`);
  }

  // Archived chats.
  for (const chat of persistState.chatState.archivedChats) {
    const id = chat.id.replaceAll("'", "''");
    const title = (chat.title || "Archived chat").replaceAll("'", "''");
    const createdAt = (chat.createdAt || "").replaceAll("'", "''");
    db.exec(
      `INSERT INTO chats (id, title, createdAt) VALUES ('${id}', '${title}', '${createdAt}');`
    );

    chat.messages.forEach((m, idx) => {
      const role = m.role.replaceAll("'", "''");
      const content = m.content.replaceAll("'", "''");
      const msgCreatedAt = m.createdAt.replaceAll("'", "''");
      db.exec(
        `INSERT INTO messages (chatId, seq, role, content, createdAt) VALUES ('${id}', ${idx}, '${role}', '${content}', '${msgCreatedAt}');`
      );
    });
  }

  // Active chat messages live in chatId='current'.
  persistState.chatState.activeMessages.forEach((m, idx) => {
    const role = m.role.replaceAll("'", "''");
    const content = m.content.replaceAll("'", "''");
    const msgCreatedAt = m.createdAt.replaceAll("'", "''");
    db.exec(
      `INSERT INTO messages (chatId, seq, role, content, createdAt) VALUES ('current', ${idx}, '${role}', '${content}', '${msgCreatedAt}');`
    );
  });

  db.exec("COMMIT;");

  const bytes = db.export();
  const base64 = encodeBase64(bytes);
  localStorage.setItem(LOCAL_STORAGE_DB_KEY, base64);
};

