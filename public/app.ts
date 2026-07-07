import { createStore } from "jotai/vanilla";
import { persistStateAtom, uiAtom, type PersistState, type UIState } from "./state";
import type { ChatMessage, ChatState } from "./chatTypes";
import {
  BUILTIN_PRESET_ID,
  createPresetId,
  findPresetById,
  findPresetByName,
  type InstructionPreset,
} from "./instructionPresets";
import {
  formatModelLabel,
  getActiveModelProfile,
  type ModelProfile,
} from "./modelProfiles";
import {
  formatVsellmModelOptionLabel,
  getSortedTextModels,
  getVsellmCatalogEntry,
  getVsellmProviderLabel,
} from "./vsellmCatalog";
import { initLocalDbAndLoad, savePersistStateToLocalDb } from "./sqliteClient";

const getEl = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const chatForm = getEl<HTMLFormElement>("chatForm");
const messageInput = getEl<HTMLTextAreaElement>("messageInput");
const chatLog = getEl<HTMLElement>("chatLog");
const sendButton = getEl<HTMLButtonElement>("sendButton");
const newChatButton = getEl<HTMLButtonElement>("newChatButton");
const recentList = getEl<HTMLElement>("recentList");
const sideMenu = getEl<HTMLElement>("sideMenu");
const menuButton = getEl<HTMLButtonElement>("menuButton");
const closeMenuButton = getEl<HTMLButtonElement>("closeMenuButton");
const menuBackdrop = getEl<HTMLDivElement>("menuBackdrop");
const savedModelSelect = getEl<HTMLSelectElement>("savedModelSelect");
const addModelButton = getEl<HTMLButtonElement>("addModelButton");
const removeModelButton = getEl<HTMLButtonElement>("removeModelButton");
const settingsSystemPromptInput = getEl<HTMLTextAreaElement>("settingsSystemPrompt");
const instructionPresetSelect = getEl<HTMLSelectElement>("instructionPresetSelect");
const instructionPresetNameInput = getEl<HTMLInputElement>("instructionPresetName");
const saveInstructionPresetButton = getEl<HTMLButtonElement>("saveInstructionPresetButton");
const deleteInstructionPresetButton = getEl<HTMLButtonElement>("deleteInstructionPresetButton");
const saveSettingsButton = getEl<HTMLButtonElement>("saveSettingsButton");
const settingsKeyStatus = getEl<HTMLParagraphElement>("settingsKeyStatus");

const formatSavedModelLabel = (modelId: string): string => {
  const entry = getVsellmCatalogEntry(modelId);
  return entry ? formatVsellmModelOptionLabel(entry) : formatModelLabel(modelId);
};

const populateCatalogModelSelect = (select: HTMLSelectElement, selectedId = "") => {
  select.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose a model";
  select.append(placeholder);

  const byProvider = new Map<string, ReturnType<typeof getSortedTextModels>>();
  getSortedTextModels().forEach((entry) => {
    const group = byProvider.get(entry.provider) ?? [];
    group.push(entry);
    byProvider.set(entry.provider, group);
  });

  [...byProvider.keys()]
    .sort((a, b) => getVsellmProviderLabel(a).localeCompare(getVsellmProviderLabel(b)))
    .forEach((provider) => {
      const optgroup = document.createElement("optgroup");
      optgroup.label = getVsellmProviderLabel(provider);
      (byProvider.get(provider) ?? []).forEach((entry) => {
        const option = document.createElement("option");
        option.value = entry.id;
        option.textContent = formatVsellmModelOptionLabel(entry);
        optgroup.append(option);
      });
      select.append(optgroup);
    });

  if (selectedId) select.value = selectedId;
  select.disabled = false;
};

const getActiveConnection = (persistState: PersistState): ModelProfile | undefined =>
  getActiveModelProfile(persistState.modelProfiles, persistState.activeModelId);

const hasActiveConnection = (persistState: PersistState): boolean => {
  const profile = getActiveConnection(persistState);
  return Boolean(profile?.apiKey && profile.modelId);
};

const store = createStore();

let dbSQL: any = null;
let db: any = null;
let isHydrating = true;
let persistTimer: number | undefined;

const resizeMessageInput = () => {
  messageInput.style.height = "auto";
  messageInput.style.height = `${messageInput.scrollHeight}px`;
};

const COPY_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const COPIED_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;

const createMessageCopyButton = (content: string) => {
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "message-copy";
  copyBtn.setAttribute("aria-label", "Copy message");
  copyBtn.innerHTML = COPY_ICON;

  let resetTimer: number | undefined;

  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(content);
      copyBtn.setAttribute("aria-label", "Copied");
      copyBtn.classList.add("message-copy--done");
      copyBtn.innerHTML = COPIED_ICON;

      if (resetTimer !== undefined) window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(() => {
        copyBtn.setAttribute("aria-label", "Copy message");
        copyBtn.classList.remove("message-copy--done");
        copyBtn.innerHTML = COPY_ICON;
        resetTimer = undefined;
      }, 1500);
    } catch {
      copyBtn.setAttribute("aria-label", "Copy failed");
    }
  });

  return copyBtn;
};

const appendMessage = (message: ChatMessage) => {
  const wrap = document.createElement("div");
  wrap.className = `message-wrap ${message.role}`;

  const bubble = document.createElement("article");
  bubble.className = `message ${message.role}`;
  bubble.textContent = message.content;

  wrap.append(bubble, createMessageCopyButton(message.content));
  chatLog.appendChild(wrap);
};

const TYPING_INDICATOR_ID = "assistant-typing-indicator";

const scrollChatToEnd = () => {
  chatLog.scrollTop = chatLog.scrollHeight;
};

const removeTypingIndicator = () => {
  document.getElementById(TYPING_INDICATOR_ID)?.remove();
};

const appendTypingIndicator = () => {
  removeTypingIndicator();

  const wrap = document.createElement("div");
  wrap.id = TYPING_INDICATOR_ID;
  wrap.className = "message-wrap assistant";

  const bubble = document.createElement("article");
  bubble.className = "message assistant typing-indicator";
  bubble.setAttribute("aria-live", "polite");

  const label = document.createElement("span");
  label.className = "typing-indicator-label";
  label.textContent = "Answering";

  const dots = document.createElement("span");
  dots.className = "typing-dots";
  dots.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i++) dots.appendChild(document.createElement("span"));

  bubble.append(label, dots);
  wrap.append(bubble);
  chatLog.appendChild(wrap);
  scrollChatToEnd();
};

let streamingWrapEl: HTMLElement | null = null;
let streamingBubbleEl: HTMLElement | null = null;

const clearStreamingBubble = () => {
  streamingWrapEl?.remove();
  streamingWrapEl = null;
  streamingBubbleEl = null;
};

const ensureStreamingBubble = () => {
  if (streamingBubbleEl && streamingWrapEl) {
    return { wrap: streamingWrapEl, bubble: streamingBubbleEl };
  }

  removeTypingIndicator();

  const wrap = document.createElement("div");
  wrap.className = "message-wrap assistant";

  const bubble = document.createElement("article");
  bubble.className = "message assistant is-streaming";
  bubble.textContent = "";

  wrap.append(bubble);
  chatLog.appendChild(wrap);
  streamingWrapEl = wrap;
  streamingBubbleEl = bubble;
  scrollChatToEnd();
  return { wrap, bubble };
};

const updateStreamingBubble = (text: string) => {
  if (!streamingBubbleEl) {
    setUi((prev) => ({ ...prev, isRevealingReply: true }));
    ensureStreamingBubble();
  }
  if (streamingBubbleEl) streamingBubbleEl.textContent = text;
  scrollChatToEnd();
};

const finalizeStreamingBubble = (fullText: string) => {
  if (!streamingWrapEl || !streamingBubbleEl) return;
  streamingBubbleEl.classList.remove("is-streaming");
  streamingBubbleEl.textContent = fullText;
  streamingWrapEl.append(createMessageCopyButton(fullText));
  streamingWrapEl = null;
  streamingBubbleEl = null;
  scrollChatToEnd();
};

type StreamDonePayload = {
  reply: string;
  state: ChatState;
};

const consumeChatStream = async (
  response: Response,
  handlers: {
    onDelta: (chunk: string, fullText: string) => void;
    onDone: (payload: StreamDonePayload) => void;
    onError: (message: string) => void;
  }
): Promise<void> => {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("text/event-stream")) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    handlers.onError(payload?.error || "Request failed.");
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    handlers.onError("Streaming is not supported in this browser.");
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const segments = buffer.split("\n\n");
    buffer = segments.pop() ?? "";

    for (const segment of segments) {
      for (const line of segment.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;

        let event: {
          type?: string;
          content?: string;
          error?: string;
          reply?: string;
          state?: ChatState;
        };
        try {
          event = JSON.parse(raw) as typeof event;
        } catch {
          continue;
        }

        if (event.type === "delta" && typeof event.content === "string") {
          fullText += event.content;
          handlers.onDelta(event.content, fullText);
          continue;
        }

        if (event.type === "error") {
          handlers.onError(event.error || "Stream failed.");
          return;
        }

        if (event.type === "done" && event.state) {
          handlers.onDone({
            reply: typeof event.reply === "string" ? event.reply : fullText,
            state: event.state,
          });
          return;
        }
      }
    }
  }

  handlers.onError("Stream ended without a response.");
};

const appendOnboardingCard = () => {
  const card = document.createElement("article");
  card.className = "message assistant onboarding";

  const title = document.createElement("p");
  title.className = "onboarding-title";
  title.textContent = "Welcome — you can start in a minute.";

  const list = document.createElement("ol");
  list.className = "onboarding-steps";

  const step1 = document.createElement("li");
  step1.textContent =
    "Open the menu (top-left) → Settings, and add a model with your API key. Keys stay in this browser only.";

  const step2 = document.createElement("li");
  step2.textContent = "Come back here and type your first message — no pop-ups unless you open setup yourself.";

  list.append(step1, step2);

  const actions = document.createElement("div");
  actions.className = "onboarding-actions";

  const openSetup = document.createElement("button");
  openSetup.type = "button";
  openSetup.className = "secondary-button";
  openSetup.textContent = "Open setup";

  actions.append(openSetup);

  card.append(title, list, actions);
  chatLog.appendChild(card);

  openSetup.addEventListener("click", () => {
    setUi((u) => ({ ...u, apiKeyPanelOpen: true }));
  });
};

const setUi = (updater: (prev: UIState) => UIState) => {
  const prev = store.get(uiAtom);
  store.set(uiAtom, updater(prev));
};

const formatDate = (value: string) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleString();
};

const getCurrentChatListItem = (chatState: ChatState) => {
  if (chatState.activeMessages.length === 0) return null;

  const firstUser = chatState.activeMessages.find((message) => message.role === "user");
  const titleSource = firstUser?.content || "Current chat";
  const title = titleSource.length > 60 ? `${titleSource.slice(0, 57)}...` : titleSource;
  const lastMessage = chatState.activeMessages[chatState.activeMessages.length - 1];

  return {
    id: "current-chat",
    title,
    createdAt: lastMessage?.createdAt || firstUser?.createdAt || "",
    messagesCount: chatState.activeMessages.length,
    isCurrent: true,
  } as const;
};

const renderChat = () => {
  const persistState = store.get(persistStateAtom);
  const ui = store.get(uiAtom);

  if (ui.isRevealingReply) return;

  chatLog.innerHTML = "";

  const { activeMessages } = persistState.chatState;

  const setupComplete = hasActiveConnection(persistState);

  if (activeMessages.length === 0) {
    if (setupComplete) {
      appendMessage({
        role: "assistant",
        content: "Hi — ask anything. Use the menu to switch models or edit instructions.",
        createdAt: new Date().toISOString(),
      });
    } else {
      appendOnboardingCard();
    }
  } else {
    activeMessages.forEach(appendMessage);
  }

  // Transient UI messages (errors) are shown at the end and are NOT persisted.
  ui.uiMessages.forEach(appendMessage);

  if (ui.isSending) appendTypingIndicator();

  scrollChatToEnd();
};

const renderRecent = () => {
  const persistState = store.get(persistStateAtom);
  const { chatState } = persistState;

  recentList.innerHTML = "";

  const currentChat = getCurrentChatListItem(chatState);
  const archived = chatState.archivedChats.map((chat) => ({
    id: chat.id,
    title: chat.title || "Archived chat",
    createdAt: chat.createdAt,
    messagesCount: chat.messages?.length || 0,
    isCurrent: false,
  }));
  const combined = currentChat ? [currentChat, ...archived] : archived;

  if (combined.length === 0) {
    const empty = document.createElement("li");
    empty.className = "archive-item";
    empty.textContent = "No chats yet.";
    recentList.appendChild(empty);
    return;
  }

  combined.forEach((chat) => {
    const item = document.createElement("li");
    item.className = "archive-item";
    item.dataset.chatId = chat.id;

    const main = document.createElement("div");
    main.className = "archive-item-main";

    const title = document.createElement("span");
    title.className = "archive-item-title";
    title.textContent = chat.isCurrent ? `Current: ${chat.title}` : chat.title;

    const meta = document.createElement("span");
    meta.className = "archive-item-meta";
    meta.textContent = `${chat.messagesCount} msgs · ${formatDate(chat.createdAt)}`;

    main.append(title, meta);
    item.append(main);

    if (!chat.isCurrent) {
      item.classList.add("clickable");
      const del = document.createElement("button");
      del.type = "button";
      del.className = "archive-delete";
      del.dataset.action = "delete";
      del.setAttribute("aria-label", `Delete chat: ${chat.title}`);
      del.textContent = "✕";
      item.append(del);
    }

    recentList.appendChild(item);
  });
};

const renderSavedModelControls = (persistState: PersistState) => {
  const ui = store.get(uiAtom);
  const { modelProfiles, activeModelId } = persistState;

  savedModelSelect.innerHTML = "";

  if (modelProfiles.length === 0) {
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = "No models yet";
    savedModelSelect.append(emptyOption);
    savedModelSelect.value = "";
  } else {
    modelProfiles.forEach((profile) => {
      const option = document.createElement("option");
      option.value = profile.modelId;
      option.textContent = formatSavedModelLabel(profile.modelId);
      savedModelSelect.append(option);
    });
    savedModelSelect.value = activeModelId || modelProfiles[0]?.modelId || "";
  }

  const activeProfile = getActiveConnection(persistState);
  settingsKeyStatus.textContent = activeProfile
    ? `API key for ${formatSavedModelLabel(activeProfile.modelId)} is stored only in this browser.`
    : "Add a model and API key to start chatting.";

  removeModelButton.disabled = !activeProfile || ui.isSending;
  addModelButton.disabled = ui.isSending;
  savedModelSelect.disabled = modelProfiles.length === 0 || ui.isSending;
};

const getInstructionDraft = (): string =>
  document.activeElement === settingsSystemPromptInput
    ? settingsSystemPromptInput.value
    : store.get(persistStateAtom).systemPrompt;

const resolveDisplayPresetId = (
  instructions: string,
  presets: InstructionPreset[]
): string | null => {
  if (!instructions.trim()) return BUILTIN_PRESET_ID;
  return presets.find((preset) => preset.instructions === instructions)?.id ?? null;
};

const renderInstructionPresetControls = (persistState: PersistState) => {
  const { instructionPresets } = persistState;
  const instructions = getInstructionDraft();
  const displayPresetId = resolveDisplayPresetId(instructions, instructionPresets);
  const activeElement = document.activeElement;
  const isEditingPresetName = activeElement === instructionPresetNameInput;

  instructionPresetSelect.innerHTML = "";

  const customOption = document.createElement("option");
  customOption.value = "";
  customOption.textContent = "Custom (unsaved)";
  instructionPresetSelect.append(customOption);

  const builtInOption = document.createElement("option");
  builtInOption.value = BUILTIN_PRESET_ID;
  builtInOption.textContent = "Built-in default";
  instructionPresetSelect.append(builtInOption);

  instructionPresets.forEach((preset) => {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.name;
    instructionPresetSelect.append(option);
  });

  if (displayPresetId === BUILTIN_PRESET_ID) {
    instructionPresetSelect.value = BUILTIN_PRESET_ID;
  } else if (displayPresetId) {
    instructionPresetSelect.value = displayPresetId;
  } else {
    instructionPresetSelect.value = "";
  }

  const selectedPreset =
    displayPresetId && displayPresetId !== BUILTIN_PRESET_ID
      ? findPresetById(instructionPresets, displayPresetId)
      : undefined;

  if (!isEditingPresetName) {
    if (selectedPreset) {
      instructionPresetNameInput.value = selectedPreset.name;
    } else if (displayPresetId === BUILTIN_PRESET_ID) {
      instructionPresetNameInput.value = "";
    }
  }

  const canDelete =
    Boolean(displayPresetId) && displayPresetId !== BUILTIN_PRESET_ID && Boolean(selectedPreset);
  deleteInstructionPresetButton.disabled = !canDelete || store.get(uiAtom).isSending;
  saveInstructionPresetButton.disabled = store.get(uiAtom).isSending;
  instructionPresetSelect.disabled = store.get(uiAtom).isSending;
  instructionPresetNameInput.disabled = store.get(uiAtom).isSending;
};

const applyInstructionPreset = (presetId: string) => {
  const persistState = store.get(persistStateAtom);

  if (presetId === BUILTIN_PRESET_ID) {
    store.set(persistStateAtom, {
      ...persistState,
      systemPrompt: "",
      selectedPresetId: BUILTIN_PRESET_ID,
    });
    settingsSystemPromptInput.value = "";
    return;
  }

  if (!presetId) return;

  const preset = findPresetById(persistState.instructionPresets, presetId);
  if (!preset) return;

  store.set(persistStateAtom, {
    ...persistState,
    systemPrompt: preset.instructions,
    selectedPresetId: preset.id,
  });
  settingsSystemPromptInput.value = preset.instructions;
};

const renderUi = () => {
  const persistState = store.get(persistStateAtom);
  const ui = store.get(uiAtom);

  // Menu
  sideMenu.classList.toggle("open", ui.isMenuOpen);
  menuBackdrop.classList.toggle("hidden", !ui.isMenuOpen);

  // Send UI — model and API key must be set under Menu → Settings.
  const canSend = hasActiveConnection(persistState) && !ui.isSending;
  sendButton.disabled = !canSend;
  messageInput.disabled = ui.isSending;
  newChatButton.disabled = ui.isSending;

  sendButton.setAttribute("aria-busy", ui.isSending ? "true" : "false");
  sendButton.setAttribute("aria-label", ui.isSending ? "Answering" : "Send message");

  if (ui.isMenuOpen) {
    renderSavedModelControls(persistState);
    if (document.activeElement !== settingsSystemPromptInput) {
      settingsSystemPromptInput.value = persistState.systemPrompt;
    }
    renderInstructionPresetControls(persistState);
    saveSettingsButton.disabled = ui.isSending;
    settingsSystemPromptInput.disabled = ui.isSending;
  }
};

const renderAll = () => {
  renderChat();
  renderRecent();
  renderUi();
};

const ensureAddModelPanel = () => {
  let panel = document.getElementById("addModelPanel");
  if (panel) return panel;

  panel = document.createElement("div");
  panel.id = "addModelPanel";
  panel.className = "api-key-overlay";
  panel.style.display = "none";

  const card = document.createElement("div");
  card.className = "api-key-card";

  const title = document.createElement("h2");
  title.textContent = "Add model";

  const hint = document.createElement("p");
  hint.className = "api-key-lead";
  hint.textContent =
    "Choose a model from the VseLLM catalog and enter its API key. Each saved model keeps its own key.";

  const modelBlock = document.createElement("div");
  modelBlock.className = "field-block";

  const modelLabel = document.createElement("label");
  modelLabel.className = "field-label";
  modelLabel.htmlFor = "addModelPanelModel";
  modelLabel.textContent = "Text model";

  const modelSelect = document.createElement("select");
  modelSelect.id = "addModelPanelModel";
  modelSelect.className = "settings-input";
  modelSelect.dataset.field = "model";
  populateCatalogModelSelect(modelSelect);

  modelBlock.append(modelLabel, modelSelect);

  const keyLabel = document.createElement("label");
  keyLabel.className = "field-label";
  keyLabel.htmlFor = "addModelPanelKey";
  keyLabel.textContent = "API key";

  const keyInput = document.createElement("input");
  keyInput.id = "addModelPanelKey";
  keyInput.type = "password";
  keyInput.autocomplete = "off";
  keyInput.placeholder = "Paste key";

  const status = document.createElement("p");
  status.className = "api-key-lead";
  status.dataset.field = "status";
  status.textContent = "";

  const row = document.createElement("div");
  row.className = "api-key-actions";

  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn-primary";
  save.textContent = "Save";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn-muted";
  cancel.textContent = "Close";

  row.append(save, cancel);

  card.append(title, hint, modelBlock, keyLabel, keyInput, status, row);
  panel.append(card);

  const persistAndClose = () => {
    const apiKey = keyInput.value.trim();
    const modelId = modelSelect.value.trim();
    if (!modelId) {
      status.textContent = "Choose a model from the list.";
      return;
    }
    if (!apiKey) {
      status.textContent = "API key is required.";
      return;
    }

    const prev = store.get(persistStateAtom);
    const existingIndex = prev.modelProfiles.findIndex((profile) => profile.modelId === modelId);
    const nextProfile: ModelProfile = { modelId, apiKey };
    const nextProfiles =
      existingIndex >= 0
        ? prev.modelProfiles.map((profile, index) => (index === existingIndex ? nextProfile : profile))
        : [...prev.modelProfiles, nextProfile];

    store.set(persistStateAtom, {
      ...prev,
      modelProfiles: nextProfiles,
      activeModelId: modelId,
    });
    setUi((prevUi) => ({
      ...prevUi,
      addModelPanelOpen: false,
      apiKeyPanelOpen: false,
    }));
  };

  save.addEventListener("click", persistAndClose);
  cancel.addEventListener("click", () => {
    setUi((prev) => ({
      ...prev,
      addModelPanelOpen: false,
      apiKeyPanelOpen: false,
    }));
  });

  document.body.appendChild(panel);
  return panel;
};

const renderAddModelPanelVisibility = () => {
  const panel = ensureAddModelPanel();
  const persistState = store.get(persistStateAtom);
  const ui = store.get(uiAtom);
  const shouldShow = ui.addModelPanelOpen || ui.apiKeyPanelOpen;
  panel.style.display = shouldShow ? "flex" : "none";

  const title = panel.querySelector("h2");
  const keyInput = panel.querySelector("input[type='password']") as HTMLInputElement | null;
  const modelSelect = panel.querySelector("select[data-field='model']") as HTMLSelectElement | null;
  const status = panel.querySelector("p[data-field='status']") as HTMLParagraphElement | null;

  if (title) {
    title.textContent = persistState.modelProfiles.length === 0 ? "Connect" : "Add model";
  }

  if (shouldShow) {
    const activeProfile = getActiveConnection(persistState);
    if (modelSelect) {
      populateCatalogModelSelect(modelSelect, activeProfile?.modelId ?? "");
    }
    if (keyInput && !keyInput.value && activeProfile?.apiKey) {
      keyInput.value = activeProfile.apiKey;
    }
    modelSelect?.focus();
    return;
  }

  if (keyInput) keyInput.value = "";
  if (status) status.textContent = "";
  if (modelSelect) populateCatalogModelSelect(modelSelect);
};

const schedulePersist = (persistState: PersistState) => {
  if (isHydrating) return;
  if (!db || !dbSQL) return;
  if (persistTimer) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    savePersistStateToLocalDb(dbSQL, db, persistState);
  }, 250);
};

const pushUiSystemMessage = (content: string) => {
  setUi((prev) => ({
    ...prev,
    uiMessages: [...prev.uiMessages, { role: "system", content, createdAt: new Date().toISOString() }],
  }));
};

const clearUiMessages = () => {
  setUi((prev) => ({ ...prev, uiMessages: [] }));
};

const boot = async () => {
  const { loaded, db: loadedDb, SQL } = await initLocalDbAndLoad();
  db = loadedDb;
  dbSQL = SQL;

  isHydrating = false;
  store.set(persistStateAtom, loaded);

  renderAll();
  renderAddModelPanelVisibility();
  resizeMessageInput();
};

// Persist changes (chatState + model profiles). Transient UI messages are not included.
store.sub(persistStateAtom, () => {
  const persistState = store.get(persistStateAtom);
  schedulePersist(persistState);
  renderChat();
  renderRecent();
  renderUi();
  renderAddModelPanelVisibility();
});

store.sub(uiAtom, () => {
  renderChat();
  renderUi();
  renderAddModelPanelVisibility();
});

messageInput.addEventListener("input", resizeMessageInput);

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const message = messageInput.value.trim();
  if (!message) return;

  const persistState = store.get(persistStateAtom);
  const activeConnection = getActiveConnection(persistState);
  if (!activeConnection) {
    pushUiSystemMessage("Add a model and API key in Menu → Settings, or tap “Open setup” below.");
    return;
  }

  const userEntry: ChatMessage = {
    role: "user",
    content: message,
    createdAt: new Date().toISOString(),
  };

  store.set(persistStateAtom, {
    ...persistState,
    chatState: {
      ...persistState.chatState,
      activeMessages: [...persistState.chatState.activeMessages, userEntry],
    },
  });

  setUi((prev) => ({ ...prev, isSending: true, isRevealingReply: false, uiMessages: [] }));
  messageInput.value = "";
  resizeMessageInput();

  try {
    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: activeConnection.apiKey,
        message,
        model: activeConnection.modelId,
        systemPrompt: persistState.systemPrompt.trim(),
        state: {
          ...persistState.chatState,
          activeMessages: persistState.chatState.activeMessages,
        },
      }),
    });

    await consumeChatStream(response, {
      onDelta: (_chunk, fullText) => {
        updateStreamingBubble(fullText);
      },
      onDone: (payload) => {
        finalizeStreamingBubble(payload.reply);
        if (payload.state?.activeMessages) {
          store.set(persistStateAtom, {
            ...store.get(persistStateAtom),
            chatState: {
              activeMessages: Array.isArray(payload.state.activeMessages)
                ? payload.state.activeMessages
                : [],
              archivedChats: Array.isArray(payload.state.archivedChats)
                ? payload.state.archivedChats
                : store.get(persistStateAtom).chatState.archivedChats,
            },
          });
        }
      },
      onError: (message) => {
        clearStreamingBubble();
        pushUiSystemMessage(message);
      },
    });
  } catch {
    clearStreamingBubble();
    pushUiSystemMessage("Network error. Please try again.");
  } finally {
    removeTypingIndicator();
    setUi((prev) => ({ ...prev, isSending: false, isRevealingReply: false }));
    messageInput.focus();
  }
});

newChatButton.addEventListener("click", async () => {
  const persistState = store.get(persistStateAtom);

  setUi((prev) => ({ ...prev, isSending: true, uiMessages: [] }));
  try {
    const response = await fetch("/api/chat/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: persistState.chatState,
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      pushUiSystemMessage(payload.error || "Failed to archive chat.");
      return;
    }

    const nextChatState: ChatState = {
      activeMessages: Array.isArray(payload.activeMessages) ? payload.activeMessages : [],
      archivedChats: Array.isArray(payload.archivedChats) ? payload.archivedChats : [],
    };
    store.set(persistStateAtom, { ...store.get(persistStateAtom), chatState: nextChatState });
  } catch {
    pushUiSystemMessage("Network error. Please try again.");
  } finally {
    setUi((prev) => ({ ...prev, isSending: false }));
    messageInput.focus();
  }
});

menuButton.addEventListener("click", () => setUi((prev) => ({ ...prev, isMenuOpen: true })));
closeMenuButton.addEventListener("click", () => setUi((prev) => ({ ...prev, isMenuOpen: false })));
menuBackdrop.addEventListener("click", () => setUi((prev) => ({ ...prev, isMenuOpen: false })));

saveSettingsButton.addEventListener("click", () => {
  const nextSystem = settingsSystemPromptInput.value;
  const prev = store.get(persistStateAtom);
  const matchingPreset = prev.instructionPresets.find((preset) => preset.instructions === nextSystem);
  store.set(persistStateAtom, {
    ...prev,
    systemPrompt: nextSystem,
    selectedPresetId: !nextSystem.trim()
      ? BUILTIN_PRESET_ID
      : matchingPreset?.id ?? null,
  });
});

savedModelSelect.addEventListener("change", () => {
  const modelId = savedModelSelect.value.trim();
  if (!modelId) return;
  const prev = store.get(persistStateAtom);
  if (!prev.modelProfiles.some((profile) => profile.modelId === modelId)) return;
  store.set(persistStateAtom, { ...prev, activeModelId: modelId });
});

addModelButton.addEventListener("click", () => {
  setUi((prev) => ({ ...prev, addModelPanelOpen: true, apiKeyPanelOpen: true }));
});

removeModelButton.addEventListener("click", () => {
  const prev = store.get(persistStateAtom);
  const activeProfile = getActiveConnection(prev);
  if (!activeProfile) return;
  if (!confirm(`Remove ${formatSavedModelLabel(activeProfile.modelId)} and its API key from this browser?`)) {
    return;
  }

  const nextProfiles = prev.modelProfiles.filter(
    (profile) => profile.modelId !== activeProfile.modelId
  );
  const nextActiveId =
    nextProfiles.find((profile) => profile.modelId === prev.activeModelId)?.modelId ??
    nextProfiles[0]?.modelId ??
    "";

  store.set(persistStateAtom, {
    ...prev,
    modelProfiles: nextProfiles,
    activeModelId: nextActiveId,
  });
});

instructionPresetSelect.addEventListener("change", () => {
  const presetId = instructionPresetSelect.value;
  if (!presetId) return;
  applyInstructionPreset(presetId);
});

settingsSystemPromptInput.addEventListener("input", () => {
  renderInstructionPresetControls(store.get(persistStateAtom));
});

saveInstructionPresetButton.addEventListener("click", () => {
  const prev = store.get(persistStateAtom);
  const instructions = settingsSystemPromptInput.value;
  const requestedName = instructionPresetNameInput.value.trim();

  if (!requestedName) {
    pushUiSystemMessage("Enter a name for the preset.");
    return;
  }

  const existingByName = findPresetByName(prev.instructionPresets, requestedName);
  const displayPresetId = resolveDisplayPresetId(instructions, prev.instructionPresets);
  const selectedPreset =
    displayPresetId && displayPresetId !== BUILTIN_PRESET_ID
      ? findPresetById(prev.instructionPresets, displayPresetId)
      : undefined;

  let nextPresets: InstructionPreset[];
  let nextSelectedId: string;

  if (existingByName) {
    nextPresets = prev.instructionPresets.map((preset) =>
      preset.id === existingByName.id ? { ...preset, name: requestedName, instructions } : preset
    );
    nextSelectedId = existingByName.id;
  } else if (selectedPreset) {
    nextPresets = prev.instructionPresets.map((preset) =>
      preset.id === selectedPreset.id
        ? { ...preset, name: requestedName, instructions }
        : preset
    );
    nextSelectedId = selectedPreset.id;
  } else {
    const preset: InstructionPreset = {
      id: createPresetId(),
      name: requestedName,
      instructions,
    };
    nextPresets = [...prev.instructionPresets, preset];
    nextSelectedId = preset.id;
  }

  store.set(persistStateAtom, {
    ...prev,
    systemPrompt: instructions,
    instructionPresets: nextPresets,
    selectedPresetId: nextSelectedId,
  });
});

deleteInstructionPresetButton.addEventListener("click", () => {
  const prev = store.get(persistStateAtom);
  const instructions = settingsSystemPromptInput.value;
  const displayPresetId = resolveDisplayPresetId(instructions, prev.instructionPresets);
  if (!displayPresetId || displayPresetId === BUILTIN_PRESET_ID) return;

  const preset = findPresetById(prev.instructionPresets, displayPresetId);
  if (!preset) return;
  if (!confirm(`Delete preset "${preset.name}"?`)) return;

  const nextPresets = prev.instructionPresets.filter((item) => item.id !== displayPresetId);
  store.set(persistStateAtom, {
    ...prev,
    instructionPresets: nextPresets,
    selectedPresetId: resolveDisplayPresetId(instructions, nextPresets),
  });
});

recentList.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const deleteBtn = target.closest("[data-action='delete']");
  if (deleteBtn instanceof HTMLElement) {
    event.preventDefault();
    event.stopPropagation();
    const item = deleteBtn.closest(".archive-item");
    if (!(item instanceof HTMLElement)) return;
    const chatId = item.dataset.chatId;
    if (!chatId) return;
    if (!confirm("Remove this chat from your history on this device?")) return;
    const persistState = store.get(persistStateAtom);
    store.set(persistStateAtom, {
      ...persistState,
      chatState: {
        ...persistState.chatState,
        archivedChats: persistState.chatState.archivedChats.filter((c) => c.id !== chatId),
      },
    });
    return;
  }

  const item = target.closest(".archive-item.clickable");
  if (!(item instanceof HTMLElement)) return;

  const chatId = item.dataset.chatId;
  if (!chatId) return;

  const persistState = store.get(persistStateAtom);

  setUi((prev) => ({ ...prev, isSending: true, uiMessages: [] }));

  try {
    const response = await fetch("/api/chat/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId,
        state: persistState.chatState,
      }),
    });

    const payload = await response.json();

    if (!response.ok) {
      pushUiSystemMessage(payload.error || "Failed to open chat.");
      return;
    }

    const nextChatState: ChatState = {
      activeMessages: Array.isArray(payload.activeMessages) ? payload.activeMessages : [],
      archivedChats: Array.isArray(payload.archivedChats) ? payload.archivedChats : [],
    };
    store.set(persistStateAtom, { ...store.get(persistStateAtom), chatState: nextChatState });
    setUi((prev) => ({ ...prev, isMenuOpen: false }));
  } catch {
    pushUiSystemMessage("Network error. Please try again.");
  } finally {
    setUi((prev) => ({ ...prev, isSending: false }));
    messageInput.focus();
  }
});

// Start after wiring handlers
void boot();

