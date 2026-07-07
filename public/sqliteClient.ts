import initSqlJs from "sql.js";
import type { ChatMessage, ChatState } from "./chatTypes";
import {
  BUILTIN_PRESET_ID,
  parseInstructionPresets,
  resolveSelectedPresetId,
  serializeInstructionPresets,
  type InstructionPreset,
} from "./instructionPresets";
import {
  parseModelProfiles,
  serializeModelProfiles,
  type ModelProfile,
} from "./modelProfiles";
import type { PersistState } from "./state";
import sqlWasmBrowser from "sql.js/dist/sql-wasm-browser.wasm";

const LOCAL_STORAGE_DB_KEY = "ai-chat-db-v1";

// Schema:
// - chats: archived chat metadata
// - messages: messages for both archived chats (chatId=<archivedId>) and active chat (chatId='current')
// - settings: modelProfiles, activeModelId, systemPrompt, instructionPresets, selectedPresetId
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

const loadSetting = (db: any, key: string): string => {
  const safeKey = key.replaceAll("'", "''");
  const result = db.exec(
    `SELECT value FROM settings WHERE key='${safeKey}' LIMIT 1;`
  ) as undefined | { values: unknown[][] }[];
  const rows = result?.[0]?.values;
  if (!rows || rows.length === 0) return "";
  return String(rows[0]?.[0] ?? "");
};

const loadModelProfiles = (db: any): ModelProfile[] => {
  const stored = parseModelProfiles(loadSetting(db, "modelProfiles"));
  if (stored.length > 0) return stored;

  const legacyApiKey = loadSetting(db, "apiKey");
  const legacyModel = loadSetting(db, "aiModel").trim();
  if (legacyApiKey && legacyModel) {
    return [{ modelId: legacyModel, apiKey: legacyApiKey }];
  }
  return [];
};

const loadActiveModelId = (db: any, profiles: ModelProfile[]): string => {
  const stored = loadSetting(db, "activeModelId").trim();
  if (stored && profiles.some((profile) => profile.modelId === stored)) return stored;
  return profiles[0]?.modelId ?? "";
};

const loadSystemPrompt = (db: any): string => loadSetting(db, "systemPrompt");

const loadInstructionPresets = (db: any): InstructionPreset[] =>
  parseInstructionPresets(loadSetting(db, "instructionPresets"));

const loadSelectedPresetId = (db: any): string | null => {
  const value = loadSetting(db, "selectedPresetId").trim();
  if (!value) return BUILTIN_PRESET_ID;
  return value;
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
      void fileName;
      return sqlWasmBrowser;
    },
  });

  const db =
    storedBase64 && storedBase64.length > 0
      ? new SQL.Database(decodeBase64(storedBase64))
      : new SQL.Database();

  db.exec(SCHEMA_SQL);

  const modelProfiles = loadModelProfiles(db);
  const activeModelId = loadActiveModelId(db, modelProfiles);
  const systemPrompt = loadSystemPrompt(db);
  const instructionPresets = loadInstructionPresets(db);
  const selectedPresetId = resolveSelectedPresetId(
    systemPrompt,
    instructionPresets,
    loadSelectedPresetId(db)
  );
  const chatState = loadChatState(db);

  const loaded: PersistState = {
    modelProfiles,
    activeModelId,
    systemPrompt,
    instructionPresets,
    selectedPresetId,
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

  db.exec("DELETE FROM chats;");
  db.exec("DELETE FROM messages;");
  db.exec(
    "DELETE FROM settings WHERE key IN ('apiKey', 'aiModel', 'modelProfiles', 'activeModelId', 'systemPrompt', 'instructionPresets', 'selectedPresetId');"
  );

  if (persistState.modelProfiles.length > 0) {
    const escapedProfiles = serializeModelProfiles(persistState.modelProfiles).replaceAll("'", "''");
    db.exec(`INSERT INTO settings (key, value) VALUES ('modelProfiles', '${escapedProfiles}');`);
  }

  if (persistState.activeModelId.trim()) {
    const escapedModelId = persistState.activeModelId.replaceAll("'", "''");
    db.exec(`INSERT INTO settings (key, value) VALUES ('activeModelId', '${escapedModelId}');`);
  }

  if (persistState.systemPrompt.trim()) {
    const escapedSp = persistState.systemPrompt.replaceAll("'", "''");
    db.exec(`INSERT INTO settings (key, value) VALUES ('systemPrompt', '${escapedSp}');`);
  }

  if (persistState.instructionPresets.length > 0) {
    const escapedPresets = serializeInstructionPresets(persistState.instructionPresets).replaceAll(
      "'",
      "''"
    );
    db.exec(`INSERT INTO settings (key, value) VALUES ('instructionPresets', '${escapedPresets}');`);
  }

  const presetId = persistState.selectedPresetId ?? "";
  if (presetId) {
    const escapedPresetId = presetId.replaceAll("'", "''");
    db.exec(`INSERT INTO settings (key, value) VALUES ('selectedPresetId', '${escapedPresetId}');`);
  }

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
