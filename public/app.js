const chatForm = document.getElementById("chatForm");
const messageInput = document.getElementById("messageInput");
const chatLog = document.getElementById("chatLog");
const sendButton = document.getElementById("sendButton");
const newChatButton = document.getElementById("newChatButton");
const recentList = document.getElementById("recentList");
const sideMenu = document.getElementById("sideMenu");
const menuButton = document.getElementById("menuButton");
const closeMenuButton = document.getElementById("closeMenuButton");
const menuBackdrop = document.getElementById("menuBackdrop");

const state = {
  activeMessages: [],
  archivedChats: [],
  isSending: false,
};

const appendMessage = (message) => {
  const bubble = document.createElement("article");
  bubble.className = `message ${message.role}`;
  bubble.textContent = message.content;
  chatLog.appendChild(bubble);
};

const renderChat = () => {
  chatLog.innerHTML = "";

  if (state.activeMessages.length === 0) {
    appendMessage({ role: "assistant", content: "Hi! Ask me anything." });
  } else {
    state.activeMessages.forEach(appendMessage);
  }

  chatLog.scrollTop = chatLog.scrollHeight;
};

const formatDate = (value) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return parsed.toLocaleString();
};

const getCurrentChatListItem = () => {
  if (state.activeMessages.length === 0) {
    return null;
  }

  const firstUser = state.activeMessages.find((message) => message.role === "user");
  const titleSource = firstUser?.content || "Current chat";
  const title = titleSource.length > 60 ? `${titleSource.slice(0, 57)}...` : titleSource;
  const lastMessage = state.activeMessages[state.activeMessages.length - 1];

  return {
    id: "current-chat",
    title,
    createdAt: lastMessage?.createdAt || firstUser?.createdAt || "",
    messagesCount: state.activeMessages.length,
    isCurrent: true,
  };
};

const renderRecent = () => {
  recentList.innerHTML = "";

  const currentChat = getCurrentChatListItem();
  const archived = state.archivedChats.map((chat) => ({
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
    if (!chat.isCurrent) {
      item.classList.add("clickable");
    }
    recentList.appendChild(item);
  });
};

const setSendingState = (isSending) => {
  state.isSending = isSending;
  sendButton.disabled = state.isSending;
  messageInput.disabled = state.isSending;
  newChatButton.disabled = state.isSending;
  sendButton.textContent = state.isSending ? "Sending..." : "Send";
};

const setMenuOpen = (isOpen) => {
  sideMenu.classList.toggle("open", isOpen);
  menuBackdrop.classList.toggle("hidden", !isOpen);
};

const loadInitialState = async () => {
  try {
    const response = await fetch("/api/chat/state");
    const payload = await response.json();

    if (!response.ok) {
      appendMessage({ role: "system", content: payload.error || "Failed to load state." });
      return;
    }

    state.activeMessages = Array.isArray(payload.activeMessages) ? payload.activeMessages : [];
    state.archivedChats = Array.isArray(payload.archivedChats) ? payload.archivedChats : [];
  } catch (error) {
    appendMessage({ role: "system", content: "Could not load chat state." });
  }

  renderChat();
  renderRecent();
};

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const message = messageInput.value.trim();
  if (!message) {
    return;
  }

  setSendingState(true);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });

    const payload = await response.json();

    if (!response.ok) {
      appendMessage({ role: "system", content: payload.error || "Request failed." });
      renderChat();
      return;
    }

    if (payload.state) {
      state.activeMessages = Array.isArray(payload.state.activeMessages) ? payload.state.activeMessages : [];
      state.archivedChats = Array.isArray(payload.state.archivedChats) ? payload.state.archivedChats : [];
      renderChat();
      renderRecent();
    }
    messageInput.value = "";
  } catch (error) {
    appendMessage({ role: "system", content: "Network error. Please try again." });
    renderChat();
  } finally {
    setSendingState(false);
    messageInput.focus();
  }
});

newChatButton.addEventListener("click", async () => {
  setSendingState(true);

  try {
    const response = await fetch("/api/chat/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const payload = await response.json();

    if (!response.ok) {
      appendMessage({ role: "system", content: payload.error || "Failed to archive chat." });
      renderChat();
      return;
    }

    state.activeMessages = Array.isArray(payload.activeMessages) ? payload.activeMessages : [];
    state.archivedChats = Array.isArray(payload.archivedChats) ? payload.archivedChats : [];
    renderChat();
    renderRecent();
  } catch (error) {
    appendMessage({ role: "system", content: "Network error. Please try again." });
    renderChat();
  } finally {
    setSendingState(false);
    messageInput.focus();
  }
});

menuButton.addEventListener("click", () => setMenuOpen(true));
closeMenuButton.addEventListener("click", () => setMenuOpen(false));
menuBackdrop.addEventListener("click", () => setMenuOpen(false));
recentList.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const item = target.closest(".archive-item.clickable");
  if (!(item instanceof HTMLElement)) {
    return;
  }

  const chatId = item.dataset.chatId;
  if (!chatId) {
    return;
  }

  setSendingState(true);

  try {
    const response = await fetch("/api/chat/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId }),
    });
    const payload = await response.json();

    if (!response.ok) {
      appendMessage({ role: "system", content: payload.error || "Failed to open chat." });
      renderChat();
      return;
    }

    state.activeMessages = Array.isArray(payload.activeMessages) ? payload.activeMessages : [];
    state.archivedChats = Array.isArray(payload.archivedChats) ? payload.archivedChats : [];
    renderChat();
    renderRecent();
    setMenuOpen(false);
  } catch (error) {
    appendMessage({ role: "system", content: "Network error. Please try again." });
    renderChat();
  } finally {
    setSendingState(false);
    messageInput.focus();
  }
});

loadInitialState();
