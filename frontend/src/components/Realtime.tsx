"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useStore, totalUnread } from "@/lib/store";
import { useSocket } from "@/lib/useSocket";
import {
  loadChats,
  loadContacts,
  loadLidMap,
  loadMessages,
  loadOrganize,
  markChatRead,
  openChat,
  refreshAccounts,
} from "@/lib/actions";
import { chatTitle, playChime, resolveChatName } from "@/lib/util";
import type { Account, Chat, Message } from "@/lib/api";

const BASE_TITLE = "MonkeyMan - Campaigns";

/** Mounted once in the root layout: owns the WebSocket, notifications and the tab title. */
export default function Realtime() {
  const router = useRouter();
  const pathname = usePathname();
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  const unread = useStore((s) => totalUnread(s.accounts));

  // Initial data + saved mute preference
  useEffect(() => {
    try {
      useStore.getState().setMuted(localStorage.getItem("wa-muted") === "1");
    } catch {}
    refreshAccounts();
    loadOrganize();
  }, []);

  // Tab title: "(3) WhatsApp Dashboard"
  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) ${BASE_TITLE}` : BASE_TITLE;
  }, [unread]);

  const goToChat = (accountId: number, chatId: number) => {
    if (pathRef.current !== "/") router.push("/");
    openChat(accountId, chatId);
  };

  const notify = (accountId: number, label: string, chat: Chat, message: Message) => {
    const s = useStore.getState();
    const contacts = s.contacts[accountId];
    const lidMap = s.lidMap[accountId];
    const contactMap = new Map((contacts ?? []).map((c) => [c.jid, c]));
    const title = `${label} · ${resolveChatName(chat, contactMap, lidMap)}`;
    const body =
      (message.sender_name && chat.is_group ? `${message.sender_name}: ` : "") +
      (chat.last_message_preview ?? "New message");

    if (!s.muted) playChime();

    const away = document.visibilityState !== "visible" || !document.hasFocus();
    if (away && typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        const n = new Notification(title, { body, tag: `chat-${chat.id}`, silent: true });
        n.onclick = () => {
          window.focus();
          goToChat(accountId, chat.id);
          n.close();
        };
        return;
      } catch {}
    }
    s.pushToast({ kind: "message", title, body, accountId, chatId: chat.id });
  };

  useSocket(
    {
      "account.status": (msg) => {
        const s = useStore.getState();
        const d = msg.data ?? {};
        const patch: Partial<Account> = {};
        if (d.status) patch.status = d.status;
        if (d.phone_number) patch.phone_number = d.phone_number;
        const prev = s.accounts.find((a) => a.id === msg.account_id);
        s.patchAccount(msg.account_id, patch);
        if (d.qr_base64) s.setQr(msg.account_id, d.qr_base64);
        if (prev && d.status && prev.status !== d.status) {
          if (d.status === "connected") s.pushToast({ kind: "info", title: `${prev.label} connected` });
          else if (d.status === "disconnected") s.pushToast({ kind: "error", title: `${prev.label} disconnected` });
        }
      },

      "message.new": (msg) => {
        const s = useStore.getState();
        const accId: number = msg.account_id;
        const { message, chat, account_label, unread_total } = msg.data as {
          message: Message;
          chat: Chat;
          account_label: string;
          unread_total: number;
        };
        s.upsertMessage(message);
        s.upsertChat(chat);
        s.patchAccount(accId, { unread_total });
        if (message.from_me) return;

        const viewing =
          document.visibilityState === "visible" &&
          document.hasFocus() &&
          pathRef.current === "/" &&
          s.activeAccountId === accId &&
          s.activeChatId === chat.id;
        if (viewing) {
          markChatRead(accId, chat.id);
          return;
        }
        if (chat.muted) return; // muted: badge only, no sound / toast / desktop alert
        notify(accId, account_label, chat, message);
      },

      "chat.updated": (msg) => {
        const s = useStore.getState();
        s.upsertChat(msg.data.chat);
        if (typeof msg.data.unread_total === "number") s.patchAccount(msg.account_id, { unread_total: msg.data.unread_total });
      },

      "message.status": (msg) => {
        const d = msg.data;
        useStore.getState().patchMessageStatus(d.chat_id, d.message_id, d.status);
        if (d.status === "failed") {
          useStore.getState().pushToast({ kind: "error", title: "Message failed to send", body: "Tap Retry on the message." });
        }
      },

      "message.updated": (msg) => {
        const s = useStore.getState();
        s.upsertMessage(msg.data.message);
        if (msg.data.chat) s.upsertChat(msg.data.chat);
      },

      "message.hidden": (msg) => {
        useStore.getState().removeMessage(msg.data.chat_id, msg.data.message_id);
      },

      "typing": (msg) => {
        const s = useStore.getState();
        const { chat_id, composing, participant } = msg.data as { chat_id: number; composing: boolean; participant: string | null };
        if (composing) {
          s.setTyping(chat_id, participant);
          setTimeout(() => s.clearTyping(chat_id), 8000);
        } else {
          s.clearTyping(chat_id);
        }
      },

      "sync.done": (msg) => {
        const s = useStore.getState();
        const id: number = msg.account_id;
        if (msg.data?.error) {
          s.pushToast({ kind: "error", title: "Sync failed", body: "Please try again in a moment." });
          return;
        }
        if (typeof msg.data?.unread_total === "number") s.patchAccount(id, { unread_total: msg.data.unread_total });
        if (s.chats[id]) loadChats(id);
        if (s.contacts[id]) loadContacts(id);
        loadLidMap(id);
        if (s.activeAccountId === id && s.activeChatId) loadMessages(id, s.activeChatId);
      },
    },
    {
      onOpen: (isReconnect) => {
        const s = useStore.getState();
        s.setWsUp(true);
        if (!isReconnect) return;
        s.pushToast({ kind: "info", title: "Reconnected" });
        refreshAccounts();
        if (s.activeAccountId) {
          loadChats(s.activeAccountId);
          loadLidMap(s.activeAccountId);
          if (s.activeChatId) loadMessages(s.activeAccountId, s.activeChatId);
        }
      },
      onClose: () => {
        const s = useStore.getState();
        if (s.wsUp) s.pushToast({ kind: "error", title: "Live connection lost", body: "Reconnecting…" });
        s.setWsUp(false);
      },
    },
  );

  return null;
}
