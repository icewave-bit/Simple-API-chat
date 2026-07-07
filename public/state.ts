import { atom } from "jotai/vanilla";
import type { ChatMessage, ChatState } from "./chatTypes";
import { BUILTIN_PRESET_ID, type InstructionPreset } from "./instructionPresets";
import type { ModelProfile } from "./modelProfiles";

export type UIState = {
  isSending: boolean;
  /** True while the latest assistant reply is being revealed character by character. */
  isRevealingReply: boolean;
  uiMessages: ChatMessage[]; // transient system/error messages (not persisted)
  isMenuOpen: boolean;
  /** True while user opened setup / add-model dialog or must configure a model. */
  apiKeyPanelOpen: boolean;
  addModelPanelOpen: boolean;
};

export type PersistState = {
  modelProfiles: ModelProfile[];
  activeModelId: string;
  /**
   * System prompt for the model. Empty string: server uses its built-in default preset.
   */
  systemPrompt: string;
  instructionPresets: InstructionPreset[];
  /** Built-in id, a saved preset id, or null when instructions were edited manually. */
  selectedPresetId: string | null;
  chatState: ChatState;
};

export const persistStateAtom = atom<PersistState>({
  modelProfiles: [],
  activeModelId: "",
  systemPrompt: "",
  instructionPresets: [],
  selectedPresetId: BUILTIN_PRESET_ID,
  chatState: { activeMessages: [], archivedChats: [] },
});

export const uiAtom = atom<UIState>({
  isSending: false,
  isRevealingReply: false,
  uiMessages: [],
  isMenuOpen: false,
  apiKeyPanelOpen: false,
  addModelPanelOpen: false,
});
