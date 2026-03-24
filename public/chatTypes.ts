export type ChatRole = "user" | "assistant" | "system";

export type ChatMessage = {
  role: ChatRole;
  content: string;
  createdAt: string;
};

export type ArchivedChat = {
  id: string;
  title: string;
  createdAt: string;
  messages: ChatMessage[];
};

export type ChatState = {
  activeMessages: ChatMessage[];
  archivedChats: ArchivedChat[];
};

