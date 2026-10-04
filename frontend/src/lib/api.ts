/** API client — all backend requests go through here. */

// Default "/api": same-origin, forwarded to the backend by the Next.js server (see next.config.ts).
// Set NEXT_PUBLIC_API_URL to a full URL only to call the backend directly.
export const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "/api").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    public status: number,
    public detail: string,
  ) {
    super(detail);
  }
}

async function request<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { "Content-Type": "application/json", ...opts.headers },
      ...opts,
    });
  } catch {
    throw new ApiError(0, "Cannot reach the backend. Is it running on port 8000?");
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
    } catch {}
    throw new ApiError(res.status, detail);
  }
  return res.json();
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

// ── Types ─────────────────────────────────────────
export type MsgStatus = "pending" | "sent" | "delivered" | "read" | "failed";
export type MsgType = "text" | "image" | "video" | "audio" | "document" | "sticker" | "other";

export interface Account {
  id: number;
  label: string;
  instance_name: string;
  phone_number: string | null;
  status: "connecting" | "connected" | "disconnected";
  created_at: string;
  unread_total: number;
}

export interface Chat {
  id: number;
  account_id: number;
  jid: string;
  name: string | null;
  custom_name: string | null;
  profile_pic_url: string | null;
  is_group: boolean;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number;
  pinned: boolean;
  archived: boolean;
  muted: boolean;
  note: string | null;
  label_ids: number[];
}

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface QuickReply {
  id: number;
  shortcut: string;
  text: string;
}

export interface GroupParticipant {
  jid: string;
  name: string | null;
  phone: string | null;
  admin: "admin" | "superadmin" | null;
}

export interface GroupInfo {
  subject: string | null;
  description: string | null;
  created: number | null;
  participants: GroupParticipant[];
  me_admin: boolean;
}

export interface QuotedInfo {
  message_id: string;
  sender: string | null;
  text: string | null;
  type: string | null;
}

export interface Reaction {
  emoji: string;
  count: number;
  mine: boolean;
}

export interface Message {
  id: number;
  account_id: number;
  chat_id: number;
  wa_message_id: string;
  client_id: string | null;
  from_me: boolean;
  sender_name: string | null;
  type: MsgType;
  text: string | null;
  status: MsgStatus;
  timestamp: string;
  quoted?: QuotedInfo;
  deleted?: boolean;
  edited?: boolean;
  starred?: boolean;
  reactions?: Reaction[];
  media_mimetype?: string;
  media_filename?: string;
}

export interface Contact {
  id: number;
  account_id: number;
  jid: string;
  name: string | null;
  profile_pic_url: string | null;
  is_group: boolean;
}

export interface QRResponse {
  status: string;
  qr_base64: string | null;
}

// ── Accounts ──────────────────────────────────────
export const listAccounts = () => request<Account[]>("/accounts");
export const createAccount = (label: string) => post<Account>("/accounts", { label });
export const getQR = (id: number) => request<QRResponse>(`/accounts/${id}/qr`);
export const disconnectAccount = (id: number) => post(`/accounts/${id}/disconnect`);
export const deleteAccount = (id: number) => request(`/accounts/${id}`, { method: "DELETE" });
export const syncAccount = (id: number) => post(`/accounts/${id}/sync`);

// ── Chats / messages ──────────────────────────────
export const listChats = (accountId: number) => request<Chat[]>(`/accounts/${accountId}/chats`);
export const listContacts = (accountId: number) => request<Contact[]>(`/accounts/${accountId}/contacts`);
export const fetchLidMap = (accountId: number) => request<Record<string, string>>(`/accounts/${accountId}/lid-map`);
export const openChat = (accountId: number, to: string) => post<Chat>(`/accounts/${accountId}/chats`, { to });

export const listMessages = (accountId: number, chatId: number, before?: number) =>
  request<{ messages: Message[]; has_more: boolean }>(
    `/accounts/${accountId}/chats/${chatId}/messages?limit=50${before ? `&before=${before}` : ""}`,
  );

export const markRead = (accountId: number, chatId: number) =>
  post(`/accounts/${accountId}/chats/${chatId}/read`);

export const clearChat = (accountId: number, chatId: number) =>
  post(`/accounts/${accountId}/chats/${chatId}/clear`);

export const sendText = (
  accountId: number,
  target: { chat_id?: number; to?: string },
  text: string,
  clientId: string,
  quotedMessageId?: string,
  mentioned?: string[],
) => post<{ message: Message; chat: Chat }>(`/accounts/${accountId}/send`, { ...target, text, client_id: clientId, quoted_message_id: quotedMessageId, mentioned });

export const sendVoice = (
  accountId: number,
  target: { chat_id?: number; to?: string },
  audioBase64: string,
  clientId: string,
) =>
  post<{ message: Message; chat: Chat }>(`/accounts/${accountId}/send-voice`, {
    ...target,
    audio_base64: audioBase64,
    client_id: clientId,
  });

export const retryMessage = (accountId: number, messageId: number) =>
  post<{ message: Message }>(`/accounts/${accountId}/messages/${messageId}/retry`);

export const getMedia = (accountId: number, messageId: number) =>
  request<{ data_url: string }>(`/accounts/${accountId}/messages/${messageId}/media`);

export const sendMedia = (
  accountId: number,
  target: { chat_id?: number; to?: string },
  mediaBase64: string,
  mediaType: "image" | "video" | "document",
  mimetype: string,
  clientId: string,
  filename?: string,
  caption?: string,
  quotedMessageId?: string,
) =>
  post<{ message: Message; chat: Chat }>(`/accounts/${accountId}/send-media`, {
    ...target,
    quoted_message_id: quotedMessageId,
    media_base64: mediaBase64,
    media_type: mediaType,
    mimetype,
    filename,
    caption,
    client_id: clientId,
  });

/** emoji "" removes your reaction */
export const reactToMessage = (accountId: number, messageId: number, emoji: string) =>
  post<{ message: Message }>(`/accounts/${accountId}/messages/${messageId}/react`, { emoji });

export const editMessage = (accountId: number, messageId: number, text: string) =>
  post<{ message: Message }>(`/accounts/${accountId}/messages/${messageId}/edit`, { text });

export const starMessage = (accountId: number, messageId: number, starred: boolean) =>
  post<{ message: Message }>(`/accounts/${accountId}/messages/${messageId}/star`, { starred });

export const listStarred = (accountId: number) =>
  request<{ message: Message; chat: Chat }[]>(`/accounts/${accountId}/starred`);

export const patchChat = (
  accountId: number,
  chatId: number,
  flags: Partial<Pick<Chat, "pinned" | "archived" | "muted" | "custom_name" | "note">>,
) =>
  request<Chat>(`/accounts/${accountId}/chats/${chatId}`, { method: "PATCH", body: JSON.stringify(flags) });

export const getGroupInfo = (accountId: number, chatId: number) =>
  request<GroupInfo>(`/accounts/${accountId}/chats/${chatId}/group`);

export const leaveGroup = (accountId: number, chatId: number) =>
  post(`/accounts/${accountId}/chats/${chatId}/leave`);

export type GalleryKind = "media" | "docs" | "links";
export type GalleryMessage = Message & { links?: string[] };
export const getGallery = (accountId: number, chatId: number, kind: GalleryKind) =>
  request<{ messages: GalleryMessage[] }>(`/accounts/${accountId}/chats/${chatId}/gallery?kind=${kind}`);

export const searchAll = (accountId: number, q: string) =>
  request<{ message: Message; chat: Chat }[]>(`/accounts/${accountId}/search?q=${encodeURIComponent(q)}`);

export const listLabels = () => request<Label[]>("/labels");
export const createLabel = (name: string) => post<Label>("/labels", { name });
export const deleteLabel = (id: number) => request(`/labels/${id}`, { method: "DELETE" });
export const setChatLabels = (accountId: number, chatId: number, labelIds: number[]) =>
  request<Chat>(`/accounts/${accountId}/chats/${chatId}/labels`, {
    method: "PUT",
    body: JSON.stringify({ label_ids: labelIds }),
  });

export const listQuickReplies = () => request<QuickReply[]>("/quick-replies");
export const createQuickReply = (shortcut: string, text: string) => post<QuickReply>("/quick-replies", { shortcut, text });
export const deleteQuickReply = (id: number) => request(`/quick-replies/${id}`, { method: "DELETE" });

export const refreshChatPhoto = (accountId: number, chatId: number) =>
  post<Chat>(`/accounts/${accountId}/chats/${chatId}/photo`);

export const deleteMessage =(accountId: number, messageId: number, scope: "me" | "everyone") =>
  post<{ ok?: boolean; message?: Message }>(`/accounts/${accountId}/messages/${messageId}/delete`, { scope });

export const forwardMessage = (accountId: number, messageId: number, target: { to_chat_id?: number; to?: string }) =>
  post<{ message: Message; chat: Chat }>(`/accounts/${accountId}/messages/${messageId}/forward`, target);

export const searchMessages = (accountId: number, chatId: number, q: string) =>
  request<{ messages: Message[] }>(`/accounts/${accountId}/chats/${chatId}/search?q=${encodeURIComponent(q)}`);

export const sendTyping = (accountId: number, chatId: number) =>
  post(`/accounts/${accountId}/chats/${chatId}/typing`);
