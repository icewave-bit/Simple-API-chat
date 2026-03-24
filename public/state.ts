import { atom } from "jotai/vanilla";
import type { ChatMessage, ChatState } from "./chatTypes";

export type UIState = {
  isSending: boolean;
  uiMessages: ChatMessage[]; // transient system/error messages (not persisted)
  isMenuOpen: boolean;
  /** True while user opened the API key dialog (change key) or must enter a key. */
  apiKeyPanelOpen: boolean;
};

export type PersistState = {
  apiKey: string;
  /** Chat completion model id (sent to server on each message). */
  model: string;
  chatState: ChatState;
};

export const persistStateAtom = atom<PersistState>({
  apiKey: "",
  model: "",
  chatState: { activeMessages: [], archivedChats: [] },
});

export const uiAtom = atom<UIState>({
  isSending: false,
  uiMessages: [],
  isMenuOpen: false,
  apiKeyPanelOpen: false,
});

