"use client";

import { useEffect, useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { searchAll, type Chat, type Contact, type Message } from "@/lib/api";
import { closeChat, loadLidMap, openChat, openChatWith, openMessage, refreshPhoto, renameChat, runSync, setChatFlags } from "@/lib/actions";
import StarredList from "./StarredList";
import { avatarColor, chatTitle, contactTitle, formatListTime, phoneFromJid, resolveChatName } from "@/lib/util";
import { Badge } from "./TopBar";
import NewChatDialog from "./NewChatDialog";

export function Avatar({ name, size = 44 }: { name: string; size?: number }) {
  const initial = (name.replace(/^\+/, "").trim()[0] || "?").toUpperCase();
  return (
    <div
      className="rounded-full flex items-center justify-center text-white font-semibold shrink-0"
      style={{ width: size, height: size, background: avatarColor(name), fontSize: size * 0.42 }}
    >
      {initial}
    </div>
  );
}

function Photo({ name, url, size, onBroken }: { name: string; url: string; size: number; onBroken?: () => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Avatar name={name} size={size} />;
  return (
    <img
      src={url}
      alt={name}
      className="rounded-full object-cover shrink-0"
      style={{ width: size, height: size }}
      onError={() => {
        setFailed(true);
        onBroken?.();
      }}
    />
  );
}

/** Profile photo with an initial-letter fallback. Pass `chat` so an expired photo link is refreshed automatically. */
export function ProfileAvatar({ name, url, size = 44, chat }: { name: string; url?: string | null; size?: number; chat?: Chat }) {
  // keyed by url so a refreshed link gets a fresh attempt
  return url ? (
    <Photo key={url} name={name} url={url} size={size} onBroken={chat ? () => refreshPhoto(chat) : undefined} />
  ) : (
    <Avatar name={name} size={size} />
  );
}

export default function ChatList() {
  const accountId = useStore((s) => s.activeAccountId);
  const account = useStore((s) => s.accounts.find((a) => a.id === s.activeAccountId));
  const chats = useStore((s) => (s.activeAccountId ? s.chats[s.activeAccountId] : undefined));
  const contacts = useStore((s) => (s.activeAccountId ? s.contacts[s.activeAccountId] : undefined));
  const activeChatId = useStore((s) => s.activeChatId);
  const lidMapData = useStore((s) => (s.activeAccountId ? s.lidMap[s.activeAccountId] : undefined));

  useEffect(() => {
    if (accountId && lidMapData === undefined) loadLidMap(accountId);
  }, [accountId, lidMapData]);

  const contactMap = useMemo(() => {
    const m = new Map<string, Contact>();
    for (const c of contacts ?? []) m.set(c.jid, c);
    return m;
  }, [contacts]);

  const resolve = useMemo(() => {
    return (chat: Chat) => resolveChatName(chat, contactMap, lidMapData);
  }, [contactMap, lidMapData]);

  const [tab, setTab] = useState<"chats" | "contacts" | "starred">("chats");
  const [query, setQuery] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  const labels = useStore((s) => s.labels);
  const [found, setFound] = useState<{ q: string; items: { message: Message; chat: Chat }[] } | null>(null);

  const q = query.trim().toLowerCase();
  const archivedCount = (chats ?? []).filter((c) => c.archived).length;
  const dedupedChats = useMemo(() => {
    if (!lidMapData) return chats ?? [];
    const phoneChats = new Set<string>();
    for (const c of chats ?? []) {
      if (c.jid.endsWith("@s.whatsapp.net")) phoneChats.add(c.jid);
    }
    return (chats ?? []).filter((c) => {
      if (c.jid.endsWith("@lid")) {
        const phoneJid = lidMapData[c.jid];
        if (phoneJid && phoneChats.has(phoneJid)) return false;
      }
      return true;
    });
  }, [chats, lidMapData]);

  const filteredChats = useMemo(
    () =>
      dedupedChats.filter(
        (c) =>
          !!c.archived === showArchived &&
          (!q ||
            resolve(c).toLowerCase().includes(q) ||
            c.jid.includes(q) ||
            labels.some((l) => c.label_ids.includes(l.id) && l.name.toLowerCase().includes(q))),
      ),
    [dedupedChats, q, showArchived, labels, resolve],
  );

  // Search inside messages of every chat of this number while typing (after a short pause)
  useEffect(() => {
    if (!accountId || tab !== "chats" || q.length < 2) return;
    let alive = true;
    const t = setTimeout(() => {
      searchAll(accountId, q)
        .then((items) => alive && setFound({ q, items }))
        .catch(() => alive && setFound({ q, items: [] }));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [accountId, tab, q]);
  const messageHits = tab === "chats" && q.length >= 2 && found?.q === q ? found.items : [];
  const filteredContacts = useMemo(
    () => (contacts ?? []).filter((c) => !q || contactTitle(c).toLowerCase().includes(q) || c.jid.includes(q)),
    [contacts, q],
  );

  if (!accountId || !account) {
    return <div className="flex-1 flex items-center justify-center text-muted p-6 text-center">Select a number above.</div>;
  }

  const tabBtn = (id: "chats" | "contacts" | "starred", label: string, count?: number) => (
    <button
      onClick={() => setTab(id)}
      className={`flex-1 py-2.5 text-sm font-medium border-b-2 transition-colors ${
        tab === id ? "border-primary text-primary" : "border-transparent text-muted hover:text-foreground"
      }`}
    >
      {label}
      {count ? <span className="ml-1.5 text-xs opacity-70">{count}</span> : null}
    </button>
  );

  return (
    <div className="flex flex-col h-full min-h-0 bg-sidebar-bg">
      <div className="px-3 pt-3 pb-2 flex items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tab === "contacts" ? "Filter contacts" : "Filter chats"}
          className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <button
          onClick={() => runSync(account.id)}
          disabled={account.status !== "connected"}
          title="Sync chats and contacts from WhatsApp"
          className="p-2 rounded-lg hover:bg-background disabled:opacity-40 text-muted"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 11-3-6.7M21 4v5h-5" />
          </svg>
        </button>
        <button
          onClick={() => setShowNew(true)}
          disabled={account.status !== "connected"}
          title="New chat"
          className="p-2 rounded-lg bg-primary text-white hover:bg-primary-dark disabled:opacity-40"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      <div className="flex border-b border-border">
        {tabBtn("chats", "Chats", (chats ?? []).filter((c) => !c.archived).length)}
        {tabBtn("contacts", "Contacts", contacts?.length)}
        {tabBtn("starred", "Starred")}
      </div>

      {tab === "chats" && showArchived && (
        <button
          onClick={() => setShowArchived(false)}
          className="w-full text-left px-3 py-2 text-sm text-primary border-b border-border/60 hover:bg-background"
        >
          ← Back to chats · Archived ({archivedCount})
        </button>
      )}
      {tab === "chats" && !showArchived && archivedCount > 0 && (
        <button
          onClick={() => setShowArchived(true)}
          className="w-full text-left px-3 py-2 text-sm text-muted border-b border-border/60 hover:bg-background"
        >
          Archived ({archivedCount})
        </button>
      )}

      {account.status !== "connected" && (
        <div className="px-3 py-2 text-xs bg-warning/10 text-yellow-800 border-b border-warning/30">
          {account.label} is {account.status}. Showing saved history only.
        </div>
      )}

      <div className="flex-1 overflow-y-auto min-h-0">
        {tab === "chats" ? (
          chats === undefined ? (
            <p className="p-6 text-center text-muted text-sm animate-pulse">Loading chats…</p>
          ) : filteredChats.length === 0 ? (
            <p className="p-6 text-center text-muted text-sm">
              {q ? "No matching chats." : "No chats yet. Press sync, or start a new chat."}
            </p>
          ) : (
            filteredChats.map((c) => (
              <div
                key={c.id}
                className={`group relative border-b border-border/60 hover:bg-background ${c.id === activeChatId ? "bg-background" : ""}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenuFor(c.id);
                  setMenuPos({ x: e.clientX, y: e.clientY });
                }}
              >
                <button onClick={() => openChat(account.id, c.id)} className="w-full flex items-center gap-3 px-3 py-2.5 text-left">
                  <ProfileAvatar name={resolve(c)} url={c.profile_pic_url} chat={c} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span className={`truncate ${c.unread_count ? "font-semibold" : "font-medium"}`}>{resolve(c)}</span>
                        {labels
                          .filter((l) => c.label_ids.includes(l.id))
                          .map((l) => (
                            <span key={l.id} title={l.name} className="w-2 h-2 rounded-full shrink-0" style={{ background: l.color }} />
                          ))}
                      </span>
                      <span className={`text-xs shrink-0 ${c.unread_count ? "text-primary font-medium" : "text-muted"}`}>
                        {formatListTime(c.last_message_at)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className={`truncate text-sm ${c.unread_count ? "text-foreground" : "text-muted"}`}>
                        {c.last_message_preview || "No messages"}
                      </span>
                      <span className="flex items-center gap-1 shrink-0">
                        {c.muted && <span className="text-muted text-xs" title="Muted">🔇</span>}
                        {c.pinned && <span className="text-muted text-xs" title="Pinned">📌</span>}
                        <Badge n={c.unread_count} className={c.muted ? "bg-gray-400 text-white" : "bg-primary text-white"} />
                      </span>
                    </div>
                  </div>
                </button>
                <button
                  onClick={() => {
                    setMenuFor(menuFor === c.id ? null : c.id);
                    setMenuPos(null);
                  }}
                  aria-label="Chat options"
                  className="absolute right-2 top-1.5 p-1 rounded-full bg-sidebar-bg/90 opacity-0 group-hover:opacity-100 focus:opacity-100 text-muted hover:text-foreground"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" />
                  </svg>
                </button>
                {menuFor === c.id && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => { setMenuFor(null); setMenuPos(null); }} />
                    <div
                      className="z-50 w-44 bg-white rounded-lg shadow-lg border border-border py-1"
                      style={
                        menuPos
                          ? { position: "fixed", left: menuPos.x, top: menuPos.y }
                          : { position: "absolute", right: 8, top: 32 }
                      }
                    >
                      {c.id === activeChatId && (
                        <button
                          onClick={() => {
                            closeChat();
                            setMenuFor(null);
                            setMenuPos(null);
                          }}
                          className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50"
                        >
                          Close chat
                        </button>
                      )}
                      {[
                        { label: c.pinned ? "Unpin chat" : "Pin chat", flags: { pinned: !c.pinned } },
                        { label: c.archived ? "Unarchive" : "Archive chat", flags: { archived: !c.archived } },
                        { label: c.muted ? "Unmute" : "Mute notifications", flags: { muted: !c.muted } },
                      ].map((item) => (
                        <button
                          key={item.label}
                          onClick={() => {
                            setChatFlags(c, item.flags);
                            setMenuFor(null);
                            setMenuPos(null);
                          }}
                          className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50"
                        >
                          {item.label}
                        </button>
                      ))}
                      <button
                        onClick={() => {
                          renameChat(c, c.custom_name || c.name || "");
                          setMenuFor(null);
                          setMenuPos(null);
                        }}
                        className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50"
                      >
                        Rename
                      </button>
                      {c.note !== undefined && (
                        <button
                          onClick={() => {
                            const note = window.prompt("Note for this chat:", c.note || "");
                            if (note !== null) setChatFlags(c, { note: note.trim() });
                            setMenuFor(null);
                            setMenuPos(null);
                          }}
                          className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50"
                        >
                          {c.note ? "Edit note" : "Add note"}
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            ))
          )
        ) : tab === "starred" ? (
          <StarredList accountId={account.id} />
        ) : contacts === undefined ? (
          <p className="p-6 text-center text-muted text-sm animate-pulse">Loading contacts…</p>
        ) : filteredContacts.length === 0 ? (
          <p className="p-6 text-center text-muted text-sm">
            {q ? "No matching contacts." : "No contacts yet. Press sync once the number is connected."}
          </p>
        ) : (
          filteredContacts.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                setTab("chats");
                openChatWith(account.id, c.jid);
              }}
              className="w-full flex items-center gap-3 px-3 py-2.5 text-left border-b border-border/60 hover:bg-background"
            >
              <ProfileAvatar name={contactTitle(c)} url={c.profile_pic_url} size={40} />
              <div className="min-w-0">
                <div className="truncate font-medium">{contactTitle(c)}</div>
                <div className="truncate text-xs text-muted">
                  {c.is_group ? "Group" : "+" + phoneFromJid(c.jid)}
                </div>
              </div>
            </button>
          ))
        )}
        {messageHits.length > 0 && (
          <div className="border-t border-border">
            <div className="px-3 py-1.5 text-xs text-muted uppercase tracking-wider bg-background">Messages</div>
            {messageHits.map(({ message, chat }) => (
              <button
                key={message.id}
                onClick={() => openMessage(account.id, chat.id, message.id)}
                className="w-full text-left px-3 py-2 border-b border-border/60 hover:bg-background"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium">{resolveChatName(chat, contactMap, lidMapData)}</span>
                  <span className="text-xs text-muted shrink-0">{formatListTime(message.timestamp)}</span>
                </div>
                <div className="truncate text-sm text-muted">{message.text}</div>
              </button>
            ))}
          </div>
        )}
      </div>


      {showNew && <NewChatDialog accountId={account.id} onClose={() => setShowNew(false)} />}
    </div>
  );
}
