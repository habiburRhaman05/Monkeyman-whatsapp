"use client";

import * as api from "./api";
import { useStore } from "./store";

const st = () => useStore.getState();
const errText = (e: unknown) => (e instanceof api.ApiError ? e.detail : "Something went wrong");

export function syncUrl() {
  try {
    const { activeAccountId: a, activeChatId: c } = st();
    const q = a ? `?account=${a}${c ? `&chat=${c}` : ""}` : "";
    window.history.replaceState(null, "", `/${q}`);
  } catch {}
}

export async function refreshAccounts() {
  try {
    st().setAccounts(await api.listAccounts());
  } catch (e) {
    if (!st().accountsLoaded) st().setAccounts([]);
    st().pushToast({ kind: "error", title: "Cannot load numbers", body: errText(e) });
  }
}

export async function loadChats(accountId: number) {
  try {
    st().setChats(accountId, await api.listChats(accountId));
  } catch (e) {
    st().pushToast({ kind: "error", title: "Cannot load chats", body: errText(e) });
  }
}

export async function loadContacts(accountId: number) {
  try {
    st().setContacts(accountId, await api.listContacts(accountId));
  } catch {}
}

export async function loadLidMap(accountId: number) {
  try {
    st().setLidMap(accountId, await api.fetchLidMap(accountId));
  } catch {}
}

export async function loadMessages(accountId: number, chatId: number) {
  try {
    const r = await api.listMessages(accountId, chatId);
    st().setMessages(chatId, r.messages, r.has_more);
  } catch (e) {
    st().pushToast({ kind: "error", title: "Cannot load messages", body: errText(e) });
  }
}

export async function loadOlder(accountId: number, chatId: number) {
  const cur = st().messages[chatId];
  if (!cur?.length) return;
  try {
    const r = await api.listMessages(accountId, chatId, cur[0].id);
    st().prependMessages(chatId, r.messages, r.has_more);
  } catch {}
}

/** Mark a chat read: local first (instant badge), then the server. */
export function markChatRead(accountId: number, chatId: number) {
  const chat = st().chats[accountId]?.find((c) => c.id === chatId);
  if (chat && chat.unread_count > 0) {
    st().upsertChat({ ...chat, unread_count: 0 });
    const acc = st().accounts.find((a) => a.id === accountId);
    if (acc) st().patchAccount(accountId, { unread_total: Math.max(0, acc.unread_total - chat.unread_count) });
  }
  api.markRead(accountId, chatId).catch(() => {});
}

/** Clear-chat: hides all messages in this dashboard only (does not touch WhatsApp). */
export async function clearChat(accountId: number, chatId: number) {
  try {
    await api.clearChat(accountId, chatId);
    st().setMessages(chatId, [], false);
    const chat = st().chats[accountId]?.find((c) => c.id === chatId);
    if (chat) st().upsertChat({ ...chat, last_message_preview: null });
    st().pushToast({ kind: "info", title: "Chat cleared" });
  } catch (e) {
    st().pushToast({ kind: "error", title: "Could not clear chat", body: errText(e) });
  }
}

export async function switchAccount(accountId: number) {
  st().setActive(accountId, null);
  syncUrl();
  await Promise.all([loadChats(accountId), loadContacts(accountId), loadLidMap(accountId)]);
}

export async function openChat(accountId: number, chatId: number) {
  if (st().activeAccountId !== accountId) {
    st().setActive(accountId, chatId);
    await Promise.all([loadChats(accountId), loadContacts(accountId), loadLidMap(accountId)]);
  }
  st().setActive(accountId, chatId);
  syncUrl();
  const chat = st().chats[accountId]?.find((c) => c.id === chatId);
  if (chat && !chat.profile_pic_url) refreshPhoto(chat);
  await loadMessages(accountId, chatId);
  markChatRead(accountId, chatId);
}

export function closeChat() {
  st().setActive(st().activeAccountId, null);
  syncUrl();
}

/** Get-or-create a chat for a phone number / jid and open it. Returns the chat id. */
export async function openChatWith(accountId: number, to: string): Promise<number | null> {
  try {
    const chat = await api.openChat(accountId, to);
    if (!st().chats[accountId]) await loadChats(accountId);
    st().upsertChat(chat);
    await openChat(accountId, chat.id);
    return chat.id;
  } catch (e) {
    st().pushToast({ kind: "error", title: "Cannot open chat", body: errText(e) });
    return null;
  }
}

export async function runSync(accountId: number) {
  try {
    await api.syncAccount(accountId);
    st().pushToast({ kind: "info", title: "Syncing chats…" });
  } catch (e) {
    st().pushToast({ kind: "error", title: "Sync failed", body: errText(e) });
  }
}

/** Instant local bubble (negative id). The server message with the same client_id replaces it. */
function optimistic(accountId: number, chatId: number, type: api.MsgType, text: string | null, clientId: string) {
  const temp: api.Message = {
    id: -Date.now(),
    account_id: accountId,
    chat_id: chatId,
    wa_message_id: `temp-${clientId}`,
    client_id: clientId,
    from_me: true,
    sender_name: null,
    type,
    text,
    status: "pending",
    timestamp: new Date().toISOString(),
  };
  st().upsertMessage(temp);
  return temp;
}

export async function sendTextMessage(
  accountId: number,
  chatId: number,
  text: string,
  clientId: string,
  quotedWaId?: string,
  mentioned?: string[],
) {
  const temp = optimistic(accountId, chatId, "text", text, clientId);
  try {
    const r = await api.sendText(accountId, { chat_id: chatId }, text, clientId, quotedWaId, mentioned);
    st().upsertMessage(r.message);
    st().upsertChat(r.chat);
  } catch (e) {
    st().patchMessageStatus(chatId, temp.id, "failed");
    st().pushToast({ kind: "error", title: "Send failed", body: errText(e) });
  }
}

export async function sendVoiceMessage(accountId: number, chatId: number, base64: string, clientId: string) {
  const temp = optimistic(accountId, chatId, "audio", null, clientId);
  try {
    const r = await api.sendVoice(accountId, { chat_id: chatId }, base64, clientId);
    st().upsertMessage(r.message);
    st().upsertChat(r.chat);
  } catch (e) {
    st().patchMessageStatus(chatId, temp.id, "failed");
    st().pushToast({ kind: "error", title: "Voice message failed", body: errText(e) });
  }
}

export async function retry(accountId: number, messageId: number, chatId: number) {
  try {
    await api.retryMessage(accountId, messageId);
    st().patchMessageStatus(chatId, messageId, "pending");
  } catch (e) {
    st().pushToast({ kind: "error", title: "Retry failed", body: errText(e) });
  }
}

export async function sendMediaMessage(
  accountId: number,
  chatId: number,
  file: File,
  caption: string,
  clientId: string,
  quotedWaId?: string,
) {
  const mediaType: "image" | "video" | "document" = file.type.startsWith("image/")
    ? "image"
    : file.type.startsWith("video/")
      ? "video"
      : "document";
  const temp = optimistic(accountId, chatId, mediaType, caption || `[${mediaType}]`, clientId);
  try {
    const b64 = await fileToBase64(file);
    const r = await api.sendMedia(accountId, { chat_id: chatId }, b64, mediaType, file.type, clientId, file.name, caption || undefined, quotedWaId);
    st().upsertMessage(r.message);
    st().upsertChat(r.chat);
  } catch (e) {
    st().patchMessageStatus(chatId, temp.id, "failed");
    st().pushToast({ kind: "error", title: "Send failed", body: errText(e) });
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result);
      resolve(result.split(",", 2)[1] ?? "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Pass the same emoji you already reacted with to remove it (like WhatsApp). */
export async function reactMessage(msg: api.Message, emoji: string) {
  const mine = msg.reactions?.find((r) => r.mine)?.emoji;
  try {
    const r = await api.reactToMessage(msg.account_id, msg.id, mine === emoji ? "" : emoji);
    st().upsertMessage(r.message);
  } catch (e) {
    st().pushToast({ kind: "error", title: "Reaction failed", body: errText(e) });
  }
}

export async function editMsg(msg: api.Message, text: string): Promise<boolean> {
  try {
    const r = await api.editMessage(msg.account_id, msg.id, text);
    st().upsertMessage(r.message);
    return true;
  } catch (e) {
    st().pushToast({ kind: "error", title: "Edit failed", body: errText(e) });
    return false;
  }
}

export async function toggleStar(msg: api.Message) {
  try {
    const r = await api.starMessage(msg.account_id, msg.id, !msg.starred);
    st().upsertMessage(r.message);
  } catch (e) {
    st().pushToast({ kind: "error", title: "Could not star message", body: errText(e) });
  }
}

/** Pin / archive / mute a chat. Applied instantly, rolled back if the server refuses. */
export async function setChatFlags(
  chat: api.Chat,
  flags: Partial<Pick<api.Chat, "pinned" | "archived" | "muted" | "custom_name" | "note">>,
) {
  st().upsertChat({ ...chat, ...flags });
  try {
    st().upsertChat(await api.patchChat(chat.account_id, chat.id, flags));
  } catch (e) {
    st().upsertChat(chat);
    st().pushToast({ kind: "error", title: "Could not update chat", body: errText(e) });
  }
}

/** Ask for a new name; empty text goes back to the name WhatsApp gives. */
export function renameChat(chat: api.Chat, current: string) {
  const next = window.prompt("Name for this chat (leave empty to use WhatsApp's name):", current);
  if (next === null) return;
  setChatFlags(chat, { custom_name: next.trim() });
}

const photoTried = new Set<number>();
/** WhatsApp photo links expire; fetch a fresh one once per chat per page load. */
export async function refreshPhoto(chat: api.Chat) {
  if (photoTried.has(chat.id)) return;
  photoTried.add(chat.id);
  try {
    const fresh = await api.refreshChatPhoto(chat.account_id, chat.id);
    if (fresh.profile_pic_url !== chat.profile_pic_url) st().upsertChat(fresh);
  } catch {}
}

export async function deleteMsg(msg: api.Message, scope: "me" | "everyone") {
  try {
    const r = await api.deleteMessage(msg.account_id, msg.id, scope);
    if (scope === "me") st().removeMessage(msg.chat_id, msg.id);
    else if (r.message) st().upsertMessage(r.message);
  } catch (e) {
    st().pushToast({ kind: "error", title: "Delete failed", body: errText(e) });
  }
}

export async function forwardMsg(accountId: number, messageId: number, toChatId: number) {
  try {
    const r = await api.forwardMessage(accountId, messageId, { to_chat_id: toChatId });
    st().upsertMessage(r.message);
    st().upsertChat(r.chat);
    st().pushToast({ kind: "info", title: "Message forwarded" });
  } catch (e) {
    st().pushToast({ kind: "error", title: "Forward failed", body: errText(e) });
  }
}

export async function searchInChat(accountId: number, chatId: number, q: string) {
  try {
    const r = await api.searchMessages(accountId, chatId, q);
    return r.messages;
  } catch (e) {
    st().pushToast({ kind: "error", title: "Search failed", body: errText(e) });
    return [];
  }
}

let typingTimer: ReturnType<typeof setTimeout> | null = null;
export function emitTyping(accountId: number, chatId: number) {
  if (typingTimer) return;
  api.sendTyping(accountId, chatId).catch(() => {});
  typingTimer = setTimeout(() => { typingTimer = null; }, 5000);
}

/** Open a chat and scroll to one message, loading older pages until it is found. */
export async function openMessage(accountId: number, chatId: number, messageId: number) {
  await openChat(accountId, chatId);
  for (let i = 0; i < 20; i++) {
    if (st().messages[chatId]?.some((m) => m.id === messageId) || !st().hasMore[chatId]) break;
    await loadOlder(accountId, chatId);
  }
  await new Promise((r) => setTimeout(r, 150));
  const el = document.getElementById(`msg-${messageId}`);
  if (!el) {
    st().pushToast({ kind: "info", title: "Could not find that message in the chat" });
    return;
  }
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("bg-yellow-100/70");
  setTimeout(() => el.classList.remove("bg-yellow-100/70"), 1500);
}

export async function loadOrganize() {
  try {
    const [labels, replies] = await Promise.all([api.listLabels(), api.listQuickReplies()]);
    st().setLabels(labels);
    st().setQuickReplies(replies);
  } catch {}
}

export async function addLabel(name: string): Promise<api.Label | null> {
  try {
    const lb = await api.createLabel(name);
    st().setLabels([...st().labels, lb].sort((a, b) => a.name.localeCompare(b.name)));
    return lb;
  } catch (e) {
    st().pushToast({ kind: "error", title: "Could not create label", body: errText(e) });
    return null;
  }
}

export async function removeLabel(id: number) {
  try {
    await api.deleteLabel(id);
    st().setLabels(st().labels.filter((l) => l.id !== id));
    for (const list of Object.values(st().chats)) {
      for (const c of list) if (c.label_ids.includes(id)) st().upsertChat({ ...c, label_ids: c.label_ids.filter((x) => x !== id) });
    }
  } catch (e) {
    st().pushToast({ kind: "error", title: "Could not delete label", body: errText(e) });
  }
}

export async function toggleChatLabel(chat: api.Chat, labelId: number) {
  const next = chat.label_ids.includes(labelId) ? chat.label_ids.filter((x) => x !== labelId) : [...chat.label_ids, labelId];
  st().upsertChat({ ...chat, label_ids: next });
  try {
    st().upsertChat(await api.setChatLabels(chat.account_id, chat.id, next));
  } catch (e) {
    st().upsertChat(chat);
    st().pushToast({ kind: "error", title: "Could not update labels", body: errText(e) });
  }
}

export async function addQuickReply(shortcut: string, text: string): Promise<boolean> {
  try {
    const r = await api.createQuickReply(shortcut, text);
    st().setQuickReplies([...st().quickReplies, r].sort((a, b) => a.shortcut.localeCompare(b.shortcut)));
    return true;
  } catch (e) {
    st().pushToast({ kind: "error", title: "Could not save quick reply", body: errText(e) });
    return false;
  }
}

export async function removeQuickReply(id: number) {
  try {
    await api.deleteQuickReply(id);
    st().setQuickReplies(st().quickReplies.filter((r) => r.id !== id));
  } catch (e) {
    st().pushToast({ kind: "error", title: "Could not delete quick reply", body: errText(e) });
  }
}
