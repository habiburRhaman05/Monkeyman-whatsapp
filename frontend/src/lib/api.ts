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

// ── Auth / session token ─────────────────────────────
const TOKEN_KEY = "mm_token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {}
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** On a 401, drop the stale token and send the user back to the login screen. */
function handleAuthFailure(status: number) {
  if (status !== 401) return;
  clearToken();
  if (typeof window !== "undefined" && window.location.pathname !== "/login") {
    window.location.href = "/login";
  }
}

async function request<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { "Content-Type": "application/json", ...authHeaders(), ...opts.headers },
      ...opts,
    });
  } catch {
    throw new ApiError(0, "Cannot reach the server. Please try again.");
  }
  if (!res.ok) {
    handleAuthFailure(res.status);
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
    } catch {}
    throw new ApiError(res.status, detail);
  }
  return res.json();
}

export async function login(email: string, password: string): Promise<{ token: string; email: string }> {
  const resp = await post<{ token: string; email: string }>("/auth/login", { email, password });
  setToken(resp.token);
  return resp;
}

export const me = () => request<{ email: string }>("/auth/me");

export function logout() {
  clearToken();
  if (typeof window !== "undefined") window.location.href = "/login";
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

// ── Contact uploads ─────────────────────────────────

export interface ContactBatch {
  id: number;
  tag: string;
  label_id: number;
  filename: string;
  total: number;
  created_at: string | null;
  counts?: { total: number; yes: number; no: number; unchecked: number };
}

export interface UploadedContact {
  id: number;
  batch_id: number;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  email: string | null;
  country_code: string | null;
  phone: string;
  extra: string | null;
  wa_status: "unchecked" | "yes" | "no";
  wa_jid: string | null;
  checked_at: string | null;
}

export interface UploadPreview {
  columns: string[];
  rows: Record<string, string>[];
  mapping: {
    first_name: string | null;
    last_name: string | null;
    name: string | null;
    email: string | null;
    phone: string | null;
    country_code: string | null;
    country_name: string | null;
    whatsapp_copy: string | null;
  };
  total_rows: number;
}

export interface UploadResult {
  batch: ContactBatch;
  label: Label;
  inserted: number;
  duplicates: number;
  invalid: number;
}

export async function previewUpload(file: File): Promise<UploadPreview> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_BASE}/contact-uploads/preview`, { method: "POST", body: form, headers: authHeaders() });
  if (!res.ok) {
    handleAuthFailure(res.status);
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.detail || res.statusText);
  }
  return res.json();
}

export async function uploadContacts(
  file: File,
  tag: string,
  mapping: {
    first_name?: string | null;
    last_name?: string | null;
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    country_code?: string | null;
    country_name?: string | null;
    whatsapp_copy?: string | null;
  },
  defaultCountryCode?: string,
): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", file);
  form.append("tag", tag);
  if (mapping.first_name) form.append("mapping_first_name", mapping.first_name);
  if (mapping.last_name) form.append("mapping_last_name", mapping.last_name);
  if (mapping.name) form.append("mapping_name", mapping.name);
  if (mapping.email) form.append("mapping_email", mapping.email);
  if (mapping.phone) form.append("mapping_phone", mapping.phone);
  if (mapping.country_code) form.append("mapping_country_code", mapping.country_code);
  if (mapping.country_name) form.append("mapping_country_name", mapping.country_name);
  if (mapping.whatsapp_copy) form.append("mapping_whatsapp_copy", mapping.whatsapp_copy);
  if (defaultCountryCode) form.append("default_country_code", defaultCountryCode);
  const res = await fetch(`${API_BASE}/contact-uploads`, { method: "POST", body: form, headers: authHeaders() });
  if (!res.ok) {
    handleAuthFailure(res.status);
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.detail || res.statusText);
  }
  return res.json();
}

export const listContactFields = () => request<{ fields: string[] }>("/contact-fields");
export const checkWhatsApp = (body: { batch_id?: number; contact_ids?: number[]; account_id: number }) =>
  post<{ checked: number; yes: number; no: number; message?: string }>("/uploaded-contacts/check-whatsapp", body);
export const listBatches = () => request<ContactBatch[]>("/contact-batches");
export const deleteBatch = (id: number) => request<{ ok: boolean }>(`/contact-batches/${id}`, { method: "DELETE" });

export const listUploadedContacts = (params: { batch_id?: number; wa?: string; q?: string; limit?: number; offset?: number }) => {
  const sp = new URLSearchParams();
  if (params.batch_id != null) sp.set("batch_id", String(params.batch_id));
  if (params.wa) sp.set("wa", params.wa);
  if (params.q) sp.set("q", params.q);
  if (params.limit) sp.set("limit", String(params.limit));
  if (params.offset) sp.set("offset", String(params.offset));
  return request<{ contacts: UploadedContact[]; total: number }>(`/uploaded-contacts?${sp}`);
};

// ── Campaigns ─────────────────────────────────────────

export interface CampaignNode {
  id: string;
  type: "message" | "wait" | "drip";
  variants?: string[];
  amount?: number;
  unit?: "minutes" | "hours" | "days";
  batch_size?: number;
  check_reply?: boolean;
}

export interface CampaignSettings {
  mode: "immediate" | "scheduled";
  daily_limit: number;
  delay_min: number;
  delay_max: number;
  start_hour: number;
  end_hour: number;
  days: number[];
  stop_on_reply: boolean;
  timezone: string;
}

export interface CampaignCounts {
  total: number;
  active: number;
  completed: number;
  replied: number;
  failed: number;
}

export interface Campaign {
  id: number;
  name: string;
  status: "draft" | "active" | "paused" | "completed";
  trigger_type: "manual" | "tag_added";
  trigger_label_id: number | null;
  sender_account_ids: number[];
  nodes: CampaignNode[];
  settings: CampaignSettings;
  created_at: string | null;
  updated_at: string | null;
  counts?: CampaignCounts;
  tag_cursor?: number;
  tag_last_checked_at?: string | null;
}

export interface TagStats {
  campaign_id: number;
  status: string;
  trigger_type: string;
  tag_cursor: number;
  tag_last_checked_at: string | null;
  total_contacts: number;
  total_enrolled: number;
  active_runs: number;
  completed_runs: number;
  failed_runs: number;
  total_sent: number;
  has_active_session: boolean;
  session_status: string | null;
}

export interface CampaignRun {
  id: number;
  campaign_id: number;
  account_id: number;
  phone: string;
  jid: string | null;
  uploaded_contact_id: number | null;
  chat_id: number | null;
  status: string;
  node_id: string | null;
  next_run_at: string | null;
  last_sent_at: string | null;
  enrolled_at: string | null;
  contact_name?: string | null;
}

export interface CampaignEvent {
  id: number;
  run_id: number;
  node_id: string | null;
  kind: string;
  variant_index: number | null;
  detail: string | null;
  at: string | null;
}

export interface CampaignBody {
  name: string;
  trigger_type?: string;
  trigger_label_id?: number | null;
  sender_account_ids?: number[];
  nodes?: CampaignNode[];
  settings?: CampaignSettings;
}

export const getSenderUsage = (tz: string) =>
  request<{ usage: Record<string, number> }>(`/campaigns/sender-usage?tz=${encodeURIComponent(tz)}`);
export const listCampaigns = () => request<Campaign[]>("/campaigns");
export const getCampaign = (id: number) => request<Campaign>(`/campaigns/${id}`);
export const createCampaign = (body: CampaignBody) => post<Campaign>("/campaigns", body);
export const updateCampaign = (id: number, body: CampaignBody) =>
  request<Campaign>(`/campaigns/${id}`, { method: "PUT", body: JSON.stringify(body) });
export const deleteCampaign = (id: number) => request<{ ok: boolean }>(`/campaigns/${id}`, { method: "DELETE" });
export const setCampaignStatus = (id: number, status: "active" | "paused") =>
  post<Campaign>(`/campaigns/${id}/status`, { status });
export const enrollContacts = (campaignId: number, body: { batch_id?: number; contact_ids?: number[] }) =>
  post<{ enrolled: number; skipped: number }>(`/campaigns/${campaignId}/enroll`, body);

export const listCampaignRuns = (id: number, params?: { status?: string; limit?: number; offset?: number }) => {
  const sp = new URLSearchParams();
  if (params?.status) sp.set("status", params.status);
  if (params?.limit) sp.set("limit", String(params.limit));
  if (params?.offset) sp.set("offset", String(params.offset));
  return request<{ runs: CampaignRun[]; total: number }>(`/campaigns/${id}/runs?${sp}`);
};

export const listCampaignEvents = (id: number, params?: { run_id?: number; limit?: number }) => {
  const sp = new URLSearchParams();
  if (params?.run_id) sp.set("run_id", String(params.run_id));
  if (params?.limit) sp.set("limit", String(params.limit));
  return request<{ events: CampaignEvent[]; total: number }>(`/campaigns/${id}/events?${sp}`);
};

// ── Immediate Start ──────────────────────────────────

export interface SenderAssignment {
  account_id: number;
  contact_ids: number[];
}

export interface ImmediateStartBody {
  sender_assignments: SenderAssignment[];
  delay: number;
}

export interface ImmediateSessionResponse {
  session_id: number;
  status: string;
  campaign_id?: number;
}

export interface ImmediateProgressResponse {
  session_id: number;
  status: string;
  current_node_index: number;
  progress: {
    nodes: Array<{
      node_index: number;
      node_id: string;
      type: string;
      senders?: Array<{ sent: number; failed: number; account_id: number }>;
      wait_seconds?: number;
      replied_during_wait?: number;
    }>;
    replied_contacts: number[];
  } | null;
  contacts: Array<{
    contact_id: number;
    phone: string;
    name: string;
    status: string;
    node_id: string | null;
  }>;
  started_at: string | null;
  finished_at: string | null;
}

export const immediateStart = (campaignId: number, body: ImmediateStartBody) =>
  post<ImmediateSessionResponse>(`/campaigns/${campaignId}/immediate-start`, body);

export const immediateLaunch = (campaignId: number, sessionId: number) =>
  post<ImmediateSessionResponse>(`/campaigns/${campaignId}/immediate-launch/${sessionId}`, {});

export const immediatePause = (campaignId: number, sessionId: number) =>
  post<ImmediateSessionResponse>(`/campaigns/${campaignId}/immediate-pause/${sessionId}`, {});

export const immediateStop = (campaignId: number, sessionId: number) =>
  post<ImmediateSessionResponse>(`/campaigns/${campaignId}/immediate-stop/${sessionId}`, {});

export const immediateProgress = (campaignId: number, sessionId: number) =>
  request<ImmediateProgressResponse>(`/campaigns/${campaignId}/immediate-progress/${sessionId}`);

export interface ImmediateActiveResponse {
  active: boolean;
  session_id?: number;
  status?: string;
  current_node_index?: number;
  config?: { sender_assignments: SenderAssignment[]; delay: number };
  started_at?: string;
}

export const immediateActive = (campaignId: number) =>
  request<ImmediateActiveResponse>(`/campaigns/${campaignId}/immediate-active`);

export const campaignTagStats = (campaignId: number) =>
  request<TagStats>(`/campaigns/${campaignId}/tag-stats`);
