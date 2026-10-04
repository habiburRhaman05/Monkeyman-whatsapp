"use client";

import { useState } from "react";
import { useStore } from "@/lib/store";
import { renameChat } from "@/lib/actions";
import { chatTitle, phoneFromJid } from "@/lib/util";
import { ProfileAvatar } from "./ChatList";
import ChatOrganize from "./ChatOrganize";
import GroupInfo from "./GroupInfo";
import MediaGallery from "./MediaGallery";

export default function ProfilePanel({ onClose }: { onClose: () => void }) {
  const chat = useStore((s) =>
    s.activeAccountId && s.activeChatId
      ? s.chats[s.activeAccountId]?.find((c) => c.id === s.activeChatId)
      : undefined,
  );
  const account = useStore((s) => s.accounts.find((a) => a.id === s.activeAccountId));
  const [tab, setTab] = useState<"info" | "media">("info");

  if (!chat) return null;

  const title = chatTitle(chat);
  const phone = chat.is_group || chat.jid.endsWith("@lid") ? null : phoneFromJid(chat.jid);

  return (
    <div className="w-80 max-w-full border-l border-border bg-sidebar-bg flex flex-col min-h-0 shrink-0 absolute inset-y-0 right-0 z-30 shadow-2xl xl:static xl:z-auto xl:shadow-none xl:h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <span className="font-semibold text-sm">{chat.is_group ? "Group info" : "Contact info"}</span>
        <button onClick={onClose} className="p-1 rounded-full hover:bg-background" aria-label="Close">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex border-b border-border shrink-0">
        {(["info", "media"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2 text-sm border-b-2 ${
              tab === t ? "border-primary text-primary font-medium" : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {t === "info" ? "Info" : "Media, docs, links"}
          </button>
        ))}
      </div>

      {tab === "media" ? (
        <MediaGallery key={chat.id} accountId={chat.account_id} chatId={chat.id} />
      ) : (
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="flex flex-col items-center py-6 gap-3 border-b border-border">
            <ProfileAvatar name={title} url={chat.profile_pic_url} size={96} chat={chat} />
            <div className="text-center px-4">
              <div className="font-semibold text-lg break-words">{title}</div>
              <button
                onClick={() => renameChat(chat, chat.custom_name || chat.name || "")}
                className="text-xs text-primary hover:underline"
              >
                Rename
              </button>
              {phone && <div className="text-sm text-muted">+{phone}</div>}
              {chat.is_group && <div className="text-sm text-muted">Group</div>}
            </div>
          </div>

          <div className="px-4 py-4 space-y-5">
            <ChatOrganize chat={chat} />
            {chat.is_group && <GroupInfo key={chat.id} accountId={chat.account_id} chatId={chat.id} />}
            {account && (
              <div>
                <div className="text-xs text-muted uppercase tracking-wider mb-1">Account</div>
                <div className="text-sm">{account.label}</div>
                {account.phone_number && <div className="text-xs text-muted">+{account.phone_number}</div>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
