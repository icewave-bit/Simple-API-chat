import { createStore } from "jotai/vanilla";
import { persistStateAtom, uiAtom, type PersistState, type UIState } from "./state";
import type { ChatMessage, ChatState } from "./chatTypes";
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
const settingsModelInput = getEl<HTMLInputElement>("settingsModel");
const settingsSystemPromptInput = getEl<HTMLTextAreaElement>("settingsSystemPrompt");
const saveSettingsButton = getEl<HTMLButtonElement>("saveSettingsButton");
const changeApiKeyButton = getEl<HTMLButtonElement>("changeApiKeyButton");
const removeApiKeyButton = getEl<HTMLButtonElement>("removeApiKeyButton");
const settingsKeyStatus = getEl<HTMLParagraphElement>("settingsKeyStatus");

const store = createStore();

let dbSQL: any = null;
let db: any = null;
let isHydrating = true;
let persistTimer: number | undefined;

const appendMessage = (message: ChatMessage) => {
  const bubble = document.createElement("article");
  bubble.className = `message ${message.role}`;
  bubble.textContent = message.content;
  chatLog.appendChild(bubble);
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
  chatLog.innerHTML = "";

  const persistState = store.get(persistStateAtom);
  const ui = store.get(uiAtom);
  const { activeMessages } = persistState.chatState;

  if (activeMessages.length === 0) {
    appendMessage({
      role: "assistant",
      content: "Hi! Ask me anything.",
      createdAt: new Date().toISOString(),
    });
  } else {
    activeMessages.forEach(appendMessage);
  }

  // Transient UI messages (errors) are shown at the end and are NOT persisted.
  ui.uiMessages.forEach(appendMessage);

  chatLog.scrollTop = chatLog.scrollHeight;
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

    const title = document.createElement("span");
    title.className = "archive-item-title";
    title.textContent = chat.isCurrent ? `Current: ${chat.title}` : chat.title;

    const meta = document.createElement("span");
    meta.className = "archive-item-meta";
    meta.textContent = `${chat.messagesCount} msgs ${formatDate(chat.createdAt)}`;

    item.append(title, meta);

    if (!chat.isCurrent) item.classList.add("clickable");
    recentList.appendChild(item);
  });
};

const renderUi = () => {
  const persistState = store.get(persistStateAtom);
  const ui = store.get(uiAtom);

  // Menu
  sideMenu.classList.toggle("open", ui.isMenuOpen);
  menuBackdrop.classList.toggle("hidden", !ui.isMenuOpen);

  // Send UI — model and API key must be set under Menu → Settings.
  const canSend =
    Boolean(persistState.apiKey) && Boolean(persistState.model.trim()) && !ui.isSending;
  sendButton.disabled = !canSend;
  messageInput.disabled = ui.isSending;
  newChatButton.disabled = ui.isSending;

  sendButton.textContent = ui.isSending ? "Sending..." : "Send";

  if (ui.isMenuOpen) {
    if (document.activeElement !== settingsModelInput) {
      settingsModelInput.value = persistState.model;
    }
    if (document.activeElement !== settingsSystemPromptInput) {
      settingsSystemPromptInput.value = persistState.systemPrompt;
    }
    settingsKeyStatus.textContent = persistState.apiKey
      ? "API key is stored only in this browser."
      : "No API key — add one via the dialog to send messages.";
    removeApiKeyButton.disabled = !persistState.apiKey || ui.isSending;
    changeApiKeyButton.disabled = ui.isSending;
    saveSettingsButton.disabled = ui.isSending;
    settingsModelInput.disabled = ui.isSending;
    settingsSystemPromptInput.disabled = ui.isSending;
  }
};

const renderAll = () => {
  renderChat();
  renderRecent();
  renderUi();
};

const ensureApiKeyPanel = () => {
  let panel = document.getElementById("apiKeyPanel");
  if (panel) return panel;

  panel = document.createElement("div");
  panel.id = "apiKeyPanel";
  panel.style.position = "fixed";
  panel.style.inset = "0";
  panel.style.background = "rgba(15, 23, 42, 0.35)";
  panel.style.display = "flex";
  panel.style.alignItems = "center";
  panel.style.justifyContent = "center";
  panel.style.zIndex = "100";

  const card = document.createElement("div");
  card.style.background = "#ffffff";
  card.style.border = "1px solid #e5e7eb";
  card.style.borderRadius = "12px";
  card.style.padding = "16px";
  card.style.width = "min(520px, 92vw)";

  const title = document.createElement("h2");
  title.textContent = "Enter your API key";
  title.style.margin = "0 0 8px 0";

  const hint = document.createElement("p");
  hint.textContent = "This key stays in your browser.";
  hint.style.margin = "0 0 12px 0";
  hint.style.color = "#4b5563";

  const label = document.createElement("label");
  label.textContent = "API key";
  label.style.display = "block";
  label.style.marginBottom = "6px";
  label.style.fontWeight = "600";

  const input = document.createElement("input");
  input.type = "password";
  input.autocomplete = "off";
  input.placeholder = "Paste API key";
  input.style.width = "100%";
  input.style.border = "1px solid #d1d5db";
  input.style.borderRadius = "10px";
  input.style.padding = "10px";

  const modelLabel = document.createElement("label");
  modelLabel.textContent = "Model";
  modelLabel.style.display = "block";
  modelLabel.style.marginBottom = "6px";
  modelLabel.style.fontWeight = "600";
  modelLabel.style.marginTop = "12px";

  const modelInput = document.createElement("input");
  modelInput.type = "text";
  modelInput.autocomplete = "off";
  modelInput.dataset.field = "model";
  modelInput.placeholder = "e.g. openai/gpt-4o-mini";
  modelInput.style.width = "100%";
  modelInput.style.border = "1px solid #d1d5db";
  modelInput.style.borderRadius = "10px";
  modelInput.style.padding = "10px";

  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.gap = "10px";
  row.style.marginTop = "12px";

  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Save key";
  save.style.background = "#2563eb";
  save.style.color = "#fff";
  save.style.border = "none";
  save.style.borderRadius = "10px";
  save.style.padding = "10px 14px";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.style.background = "#e5e7eb";
  cancel.style.color = "#1f2937";
  cancel.style.border = "none";
  cancel.style.borderRadius = "10px";
  cancel.style.padding = "10px 14px";

  row.append(save, cancel);

  panel.append(card);
  card.append(title, hint, label, input, modelLabel, modelInput, row);

  const persistAndClose = () => {
    const apiKey = input.value.trim();
    const model = modelInput.value.trim();
    if (!apiKey) return;
    if (!model) return;
    const prev = store.get(persistStateAtom);
    store.set(persistStateAtom, { ...prev, apiKey, model });
    setUi((u) => ({ ...u, apiKeyPanelOpen: false }));
  };

  save.addEventListener("click", persistAndClose);
  cancel.addEventListener("click", () => {
    setUi((u) => ({ ...u, apiKeyPanelOpen: false }));
  });

  document.body.appendChild(panel);
  return panel;
};

const renderApiKeyPanelVisibility = () => {
  const panel = ensureApiKeyPanel();
  const persistState = store.get(persistStateAtom);
  const ui = store.get(uiAtom);
  const h2 = panel.querySelector("h2");
  if (h2) {
    const modelMissing = !persistState.model.trim();
    if (!persistState.apiKey && modelMissing) h2.textContent = "Enter API key and model";
    else if (!persistState.apiKey) h2.textContent = "Enter your API key";
    else if (modelMissing) h2.textContent = "Enter model type";
    else h2.textContent = "Change API key and model";
  }
  const shouldShow =
    !persistState.apiKey || !persistState.model.trim() || ui.apiKeyPanelOpen;
  panel.style.display = shouldShow ? "flex" : "none";

  if (shouldShow) {
    const input = panel.querySelector("input[type='password']") as HTMLInputElement | null;
    const modelInput = panel.querySelector("input[data-field='model']") as
      | HTMLInputElement
      | null;

    if (modelInput && persistState.model.trim()) modelInput.value = persistState.model;

    if (!persistState.apiKey) {
      if (input) input.placeholder = "Paste API key";
      input?.focus();
      return;
    }
    modelInput?.focus();
  }
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
  renderApiKeyPanelVisibility();
};

// Persist changes (chatState + apiKey). Transient UI messages are not included.
store.sub(persistStateAtom, () => {
  const persistState = store.get(persistStateAtom);
  schedulePersist(persistState);
  renderChat();
  renderRecent();
  renderUi();
  renderApiKeyPanelVisibility();
});

store.sub(uiAtom, () => {
  renderChat();
  renderUi();
  renderApiKeyPanelVisibility();
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const message = messageInput.value.trim();
  if (!message) return;

  const persistState = store.get(persistStateAtom);
  if (!persistState.apiKey || !persistState.model.trim()) {
    renderApiKeyPanelVisibility();
    return;
  }

  setUi((prev) => ({ ...prev, isSending: true, uiMessages: [] }));

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: persistState.apiKey,
        message,
        model: persistState.model.trim(),
        systemPrompt: persistState.systemPrompt.trim(),
        state: persistState.chatState,
      }),
    });

    const payload = await response.json();

    if (!response.ok) {
      pushUiSystemMessage(payload.error || "Request failed.");
      return;
    }

    if (payload.state?.activeMessages) {
      const nextChatState: ChatState = {
        activeMessages: Array.isArray(payload.state.activeMessages) ? payload.state.activeMessages : [],
        archivedChats: Array.isArray(payload.state.archivedChats) ? payload.state.archivedChats : [],
      };
      store.set(persistStateAtom, { ...store.get(persistStateAtom), chatState: nextChatState });
    }

    messageInput.value = "";
  } catch {
    pushUiSystemMessage("Network error. Please try again.");
  } finally {
    setUi((prev) => ({ ...prev, isSending: false }));
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
        apiKey: persistState.apiKey,
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
  const nextModel = settingsModelInput.value.trim();
  if (!nextModel) {
    pushUiSystemMessage("Model cannot be empty.");
    return;
  }
  const nextSystem = settingsSystemPromptInput.value;
  store.set(persistStateAtom, {
    ...store.get(persistStateAtom),
    model: nextModel,
    systemPrompt: nextSystem,
  });
});

changeApiKeyButton.addEventListener("click", () => {
  const panel = ensureApiKeyPanel();
  const input = panel.querySelector("input[type='password']") as HTMLInputElement | null;
  if (input) {
    input.value = "";
    input.placeholder = "New API key";
  }
  setUi((prev) => ({ ...prev, apiKeyPanelOpen: true }));
  input?.focus();
});

removeApiKeyButton.addEventListener("click", () => {
  if (
    !confirm(
      "Remove the API key from this browser? You will need to enter it again to send messages."
    )
  ) {
    return;
  }
  store.set(persistStateAtom, { ...store.get(persistStateAtom), apiKey: "" });
  setUi((prev) => ({ ...prev, apiKeyPanelOpen: false }));
});

recentList.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

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
        apiKey: persistState.apiKey,
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

