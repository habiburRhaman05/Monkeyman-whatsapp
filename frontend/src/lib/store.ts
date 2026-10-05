"use client";

import { create } from "zustand";
import type { Account, Campaign, Chat, Contact, ContactBatch, Label, Message, MsgStatus, QuickReply, UploadedContact } from "./api";

export interface Toast {
  id: number;
  kind: "message" | "info" | "error";
  title: string;
  body?: string;
  accountId?: number;
  chatId?: number;
}

export interface ReplyTo {
  id: number;
  wa_message_id: string;
  sender_name: string | null;
  from_me: boolean;
  text: string | null;
  type: string;
}

interface State {
  accounts: Account[];
  accountsLoaded: boolean;
  activeAccountId: number | null;
  activeChatId: number | null;
  chats: Record<number, Chat[]>; // by account id, sorted newest first
  contacts: Record<number, Contact[]>; // by account id
  lidMap: Record<number, Record<string, string>>; // account_id -> {lid_jid: phone_jid}
  messages: Record<number, Message[]>; // by chat id, oldest first
  hasMore: Record<number, boolean>;
  qr: Record<number, string>; // latest QR per account id
  toasts: Toast[];
  muted: boolean;
  wsUp: boolean;
  typing: Record<number, string | null>; // chat_id -> participant name or null
  replyTo: ReplyTo | null;
  editing: Message | null;
  labels: Label[];
  quickReplies: QuickReply[];
  batches: ContactBatch[];
  uploadedContacts: UploadedContact[];
  uploadedTotal: number;
  campaigns: Campaign[];
  immediateSession: {
    sessionId: number;
    campaignId: number;
    status: string;
    currentNodeIndex: number;
    nodeResults: Array<{
      nodeIndex: number;
      nodeId: string;
      type: string;
      sent?: number;
      failed?: number;
      repliedDuringWait?: number;
      waitSeconds?: number;
      elapsed?: number;
    }>;
    contactEvents: Array<{
      contactId: number;
      phone: string;
      name: string;
      status: "sent" | "failed" | "skipped" | "pending";
      nodeIndex: number;
      accountId: number;
    }>;
  } | null;

  setAccounts: (a: Account[]) => void;
  patchAccount: (id: number, patch: Partial<Account>) => void;
  removeAccount: (id: number) => void;
  setActive: (accountId: number | null, chatId: number | null) => void;
  setChats: (accountId: number, chats: Chat[]) => void;
  upsertChat: (chat: Chat) => void;
  setContacts: (accountId: number, c: Contact[]) => void;
  setLidMap: (accountId: number, map: Record<string, string>) => void;
  setMessages: (chatId: number, msgs: Message[], hasMore: boolean) => void;
  prependMessages: (chatId: number, msgs: Message[], hasMore: boolean) => void;
  upsertMessage: (msg: Message) => void;
  patchMessageStatus: (chatId: number, messageId: number, status: MsgStatus) => void;
  removeMessage: (chatId: number, messageId: number) => void;
  setQr: (accountId: number, qr: string) => void;
  pushToast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: number) => void;
  setMuted: (m: boolean) => void;
  setWsUp: (up: boolean) => void;
  setTyping: (chatId: number, participant: string | null) => void;
  clearTyping: (chatId: number) => void;
  setReplyTo: (r: ReplyTo | null) => void;
  setEditing: (m: Message | null) => void;
  setLabels: (l: Label[]) => void;
  setQuickReplies: (r: QuickReply[]) => void;
  setBatches: (b: ContactBatch[]) => void;
  setUploadedContacts: (c: UploadedContact[], total: number) => void;
  setCampaigns: (c: Campaign[]) => void;
  setImmediateSession: (s: State["immediateSession"]) => void;
  updateImmediateProgress: (data: any) => void;
}

const STATUS_RANK: Record<MsgStatus, number> = { pending: 0, failed: 1, sent: 2, delivered: 3, read: 4 };

const byTimeThenId =(a: Message, b: Message) =>
  a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.id - b.id;

const sortChats = (list: Chat[]) =>
  [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (!a.last_message_at && !b.last_message_at) return b.id - a.id;
    if (!a.last_message_at) return 1;
    if (!b.last_message_at) return -1;
    return a.last_message_at < b.last_message_at ? 1 : a.last_message_at > b.last_message_at ? -1 : 0;
  });

let toastSeq = 1;

export const useStore = create<State>((set) => ({
  accounts: [],
  accountsLoaded: false,
  activeAccountId: null,
  activeChatId: null,
  chats: {},
  contacts: {},
  lidMap: {},
  messages: {},
  hasMore: {},
  qr: {},
  toasts: [],
  muted: false,
  wsUp: false,
  typing: {},
  replyTo: null,
  editing: null,
  labels: [],
  quickReplies: [],
  batches: [],
  uploadedContacts: [],
  uploadedTotal: 0,
  campaigns: [],
  immediateSession: null,

  setAccounts: (accounts) => set({ accounts, accountsLoaded: true }),
  patchAccount: (id, patch) =>
    set((s) => ({ accounts: s.accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)) })),
  removeAccount: (id) => set((s) => ({ accounts: s.accounts.filter((a) => a.id !== id) })),
  setActive: (activeAccountId, activeChatId) => set({ activeAccountId, activeChatId }),

  setChats: (accountId, chats) => set((s) => ({ chats: { ...s.chats, [accountId]: sortChats(chats) } })),
  upsertChat: (chat) =>
    set((s) => {
      const list = s.chats[chat.account_id];
      if (!list) return s; // not loaded yet; will be fetched when the account is opened
      const next = list.some((c) => c.id === chat.id) ? list.map((c) => (c.id === chat.id ? chat : c)) : [...list, chat];
      return { chats: { ...s.chats, [chat.account_id]: sortChats(next) } };
    }),
  setContacts: (accountId, c) => set((s) => ({ contacts: { ...s.contacts, [accountId]: c } })),
  setLidMap: (accountId, map) => set((s) => ({ lidMap: { ...s.lidMap, [accountId]: map } })),

  setMessages: (chatId, msgs, hasMore) =>
    set((s) => ({
      messages: { ...s.messages, [chatId]: msgs },
      hasMore: { ...s.hasMore, [chatId]: hasMore },
    })),
  prependMessages: (chatId, older, hasMore) =>
    set((s) => {
      const cur = s.messages[chatId] ?? [];
      const ids = new Set(cur.map((m) => m.id));
      return {
        messages: { ...s.messages, [chatId]: [...older.filter((m) => !ids.has(m.id)), ...cur] },
        hasMore: { ...s.hasMore, [chatId]: hasMore },
      };
    }),
  upsertMessage: (msg) =>
    set((s) => {
      const cur = s.messages[msg.chat_id];
      if (!cur) return s; // chat not opened yet; loaded from the DB when it is
      const same = (m: Message) => m.id === msg.id || (!!msg.client_id && m.client_id === msg.client_id);
      // A slow HTTP reply can carry an older snapshot than a WebSocket update that already landed: never downgrade.
      const prev = cur.find(same);
      const next = prev && STATUS_RANK[prev.status] > STATUS_RANK[msg.status] ? { ...msg, status: prev.status } : msg;
      const rest = cur.filter((m) => !same(m));
      return { messages: { ...s.messages, [msg.chat_id]: [...rest, next].sort(byTimeThenId) } };
    }),
  patchMessageStatus: (chatId, messageId, status) =>
    set((s) => {
      const cur = s.messages[chatId];
      if (!cur) return s;
      return { messages: { ...s.messages, [chatId]: cur.map((m) => (m.id === messageId ? { ...m, status } : m)) } };
    }),

  removeMessage: (chatId, messageId) =>
    set((s) => {
      const cur = s.messages[chatId];
      if (!cur) return s;
      return { messages: { ...s.messages, [chatId]: cur.filter((m) => m.id !== messageId) } };
    }),

  setQr: (accountId, qr) => set((s) => ({ qr: { ...s.qr, [accountId]: qr } })),

  pushToast: (t) =>
    set((s) => ({ toasts: [...s.toasts, { ...t, id: toastSeq++ }].slice(-3) })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setMuted: (muted) => set({ muted }),
  setWsUp: (wsUp) => set({ wsUp }),
  setTyping: (chatId, participant) => set((s) => ({ typing: { ...s.typing, [chatId]: participant } })),
  clearTyping: (chatId) => set((s) => {
    const next = { ...s.typing };
    delete next[chatId];
    return { typing: next };
  }),
  setReplyTo: (replyTo) => set({ replyTo, editing: null }),
  setEditing: (editing) => set({ editing, replyTo: null }),
  setLabels: (labels) => set({ labels }),
  setQuickReplies: (quickReplies) => set({ quickReplies }),
  setBatches: (batches) => set({ batches }),
  setUploadedContacts: (uploadedContacts, uploadedTotal) => set({ uploadedContacts, uploadedTotal }),
  setCampaigns: (campaigns) => set({ campaigns }),
  setImmediateSession: (immediateSession) => set({ immediateSession }),
  updateImmediateProgress: (data: any) =>
    set((s) => {
      const sess = s.immediateSession;
      if (!sess) return s;

      const kind = data.kind as string;

      if (kind === "node_start") {
        return { immediateSession: { ...sess, currentNodeIndex: data.node_index } };
      }

      if (kind === "contact_sent" || kind === "contact_failed" || kind === "contact_skipped") {
        const status = kind === "contact_sent" ? "sent" as const : kind === "contact_failed" ? "failed" as const : "skipped" as const;
        const existing = sess.contactEvents.findIndex(
          (e) => e.contactId === data.contact_id && e.nodeIndex === data.node_index
        );
        const evt = {
          contactId: data.contact_id,
          phone: data.phone,
          name: data.name,
          status,
          nodeIndex: data.node_index,
          accountId: data.account_id,
        };
        const events = [...sess.contactEvents];
        if (existing >= 0) events[existing] = evt;
        else events.push(evt);
        return { immediateSession: { ...sess, contactEvents: events } };
      }

      if (kind === "node_complete") {
        const nr: any = {
          nodeIndex: data.node_index,
          nodeId: data.node_id,
          type: data.node_type,
          sent: data.sent,
          failed: data.failed,
          repliedDuringWait: data.replied_during_wait,
          batchesCompleted: data.batches_completed,
        };
        return { immediateSession: { ...sess, nodeResults: [...sess.nodeResults, nr] } };
      }

      if (kind === "drip_batch") {
        const results = [...sess.nodeResults];
        const idx = results.findIndex((r) => r.nodeIndex === data.node_index);
        const update: any = {
          nodeIndex: data.node_index,
          nodeId: "",
          type: "drip",
          sent: (idx >= 0 ? (results[idx] as any).sent || 0 : 0) + (data.sent || 0),
          failed: (idx >= 0 ? (results[idx] as any).failed || 0 : 0) + (data.failed || 0),
          batchesCompleted: data.batch,
          totalBatches: data.total_batches,
        };
        if (idx >= 0) results[idx] = update;
        else results.push(update);
        return { immediateSession: { ...sess, nodeResults: results } };
      }

      if (kind === "wait_tick") {
        const results = [...sess.nodeResults];
        const idx = results.findIndex((r) => r.nodeIndex === data.node_index);
        if (idx >= 0) {
          results[idx] = { ...results[idx], elapsed: data.elapsed, waitSeconds: data.total };
        } else {
          results.push({ nodeIndex: data.node_index, nodeId: "", type: "wait", elapsed: data.elapsed, waitSeconds: data.total });
        }
        return { immediateSession: { ...sess, nodeResults: results } };
      }

      if (kind === "completed") {
        return { immediateSession: { ...sess, status: "completed" } };
      }

      if (kind === "error") {
        return { immediateSession: { ...sess, status: "failed" } };
      }

      return s;
    }),
}));

export const totalUnread = (accounts: Account[]) => accounts.reduce((n, a) => n + (a.unread_total || 0), 0);
