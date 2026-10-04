"use client";

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { clearChat, closeChat, loadOlder, markChatRead, searchInChat, setChatFlags } from "@/lib/actions";
import { chatTitle, formatDay, phoneFromJid, resolveChatName } from "@/lib/util";
import type { Contact, Message } from "@/lib/api";
import Bubble from "./Bubble";
import Composer from "./Composer";
import { ProfileAvatar } from "./ChatList";
import ProfilePanel from "./ProfilePanel";

export default function Conversation() {
  const accountId = useStore((s) => s.activeAccountId);
  const chatId = useStore((s) => s.activeChatId);
  const account = useStore((s) => s.accounts.find((a) => a.id === s.activeAccountId));
  const chat = useStore((s) => (s.activeAccountId && s.activeChatId ? s.chats[s.activeAccountId]?.find((c) => c.id === s.activeChatId) : undefined));
  const msgs = useStore((s) => (s.activeChatId ? s.messages[s.activeChatId] : undefined));
  const hasMore = useStore((s) => (s.activeChatId ? s.hasMore[s.activeChatId] : false));
  const typingParticipant = useStore((s) => (s.activeChatId ? s.typing[s.activeChatId] : undefined));
  const contacts = useStore((s) => (s.activeAccountId ? s.contacts[s.activeAccountId] : undefined));
  const lidMapData = useStore((s) => (s.activeAccountId ? s.lidMap[s.activeAccountId] : undefined));

  const contactMap = useMemo(() => {
    const m = new Map<string, Contact>();
    for (const c of contacts ?? []) m.set(c.jid, c);
    return m;
  }, [contacts]);

  const boxRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const loadingOlderRef = useRef(false);
  const prevRef = useRef<{ chatId: number | null; firstId: number | null; lastId: number | null; height: number }>({
    chatId: null, firstId: null, lastId: null, height: 0,
  });
  const [, force] = useState(0);
  const [showProfile, setShowProfile] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Message[] | null>(null);
  const [highlightId, setHighlightId] = useState<number | null>(null);

  // Close panels when chat changes
  useEffect(() => {
    setShowProfile(false);
    setShowSearch(false);
    setShowMenu(false);
    setSearchQuery("");
    setSearchResults(null);
    setHighlightId(null);
  }, [chatId]);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || !msgs) return;
    const first = msgs[0]?.id ?? null;
    const last = msgs[msgs.length - 1]?.id ?? null;
    const prev = prevRef.current;
    if (prev.chatId !== chatId) {
      el.scrollTop = el.scrollHeight;
      stickRef.current = true;
    } else if (first !== prev.firstId && last === prev.lastId) {
      el.scrollTop = el.scrollHeight - prev.height + el.scrollTop;
    } else if (last !== prev.lastId) {
      const mine = msgs[msgs.length - 1]?.from_me;
      if (stickRef.current || mine) el.scrollTop = el.scrollHeight;
    }
    prevRef.current = { chatId, firstId: first, lastId: last, height: el.scrollHeight };
  }, [msgs, chatId]);

  useEffect(() => {
    if (!accountId || !chatId) return;
    const onFocus = () => {
      if (document.visibilityState === "visible") markChatRead(accountId, chatId);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [accountId, chatId]);

  if (!accountId || !chatId || !account) {
    return (
      <div className="flex-1 hidden md:flex flex-col items-center justify-center text-muted bg-background gap-2">
        <div className="text-5xl">💬</div>
        <p>Select a chat to start messaging</p>
      </div>
    );
  }

  const title = chat ? resolveChatName(chat, contactMap, lidMapData) : "Chat";

  async function onScroll() {
    const el = boxRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (el.scrollTop < 100 && hasMore && !loadingOlderRef.current && accountId && chatId) {
      loadingOlderRef.current = true;
      force((n) => n + 1);
      await loadOlder(accountId, chatId);
      loadingOlderRef.current = false;
      force((n) => n + 1);
    }
  }

  async function doSearch() {
    if (!searchQuery.trim() || !accountId || !chatId) return;
    const results = await searchInChat(accountId, chatId, searchQuery.trim());
    setSearchResults(results);
  }

  function jumpToResult(msg: Message) {
    setHighlightId(msg.id);
    setTimeout(() => setHighlightId(null), 2000);
    const el = document.getElementById(`msg-${msg.id}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return (
    <div className="flex-1 flex min-w-0 min-h-0 relative">
      <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-[#efeae2]">
        {/* Header */}
        <div className="flex items-center gap-3 px-3 py-2 bg-sidebar-bg border-b border-border shrink-0">
          <button onClick={closeChat} className="md:hidden p-2 -ml-1 rounded-full hover:bg-background" aria-label="Back">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <button onClick={() => setShowProfile(!showProfile)} className="flex items-center gap-3 min-w-0 flex-1">
            <ProfileAvatar name={title} url={chat?.profile_pic_url} size={40} chat={chat} />
            <div className="min-w-0 text-left">
              <div className="font-semibold truncate">{title}</div>
              <div className="text-xs text-muted truncate">
                {typingParticipant !== undefined && typingParticipant !== null
                  ? <span className="text-primary italic">{chat?.is_group ? `${typingParticipant} is typing...` : "typing..."}</span>
                  : <>
                      {chat?.is_group ? "Group" : chat ? "+" + phoneFromJid(chat.jid) : ""} · {account.label}
                    </>
                }
              </div>
            </div>
          </button>
          <button
            onClick={() => { setShowSearch(!showSearch); setSearchResults(null); setSearchQuery(""); }}
            title="Search in chat"
            className="p-2 rounded-full hover:bg-background text-muted"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
            </svg>
          </button>
          <div className="relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              title="Chat options"
              className="p-2 rounded-full hover:bg-background text-muted"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" />
              </svg>
            </button>
            {showMenu && chat && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 w-56 bg-white rounded-lg shadow-lg border border-border py-1">
                  <button
                    onClick={() => { setShowProfile(true); setShowMenu(false); }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                  >
                    {chat.is_group ? "Group info" : "View contact"}
                  </button>
                  <button
                    onClick={() => { setChatFlags(chat, { muted: !chat.muted }); setShowMenu(false); }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                  >
                    {chat.muted ? "Unmute notifications" : "Mute notifications"}
                  </button>
                  <button
                    onClick={() => { setChatFlags(chat, { archived: !chat.archived }); setShowMenu(false); closeChat(); }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                  >
                    {chat.archived ? "Unarchive chat" : "Archive chat"}
                  </button>
                  <button
                    onClick={() => {
                      setShowMenu(false);
                      if (window.confirm("Clear this chat? Messages stay on WhatsApp — this only clears them from this dashboard.")) {
                        clearChat(accountId, chatId);
                      }
                    }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                  >
                    Clear chat
                  </button>
                  <div className="my-1 border-t border-border" />
                  <button
                    onClick={() => { setShowMenu(false); closeChat(); }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                  >
                    Close chat
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Search bar */}
        {showSearch && (
          <div className="px-3 py-2 bg-sidebar-bg border-b border-border flex gap-2 shrink-0">
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doSearch()}
              placeholder="Search messages..."
              className="flex-1 px-3 py-1.5 text-sm rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary"
              autoFocus
            />
            <button onClick={doSearch} className="px-3 py-1.5 text-sm bg-primary text-white rounded-lg hover:bg-primary-dark">
              Search
            </button>
          </div>
        )}
        {searchResults !== null && (
          <div className="px-3 py-2 bg-white border-b border-border max-h-40 overflow-y-auto shrink-0">
            {searchResults.length === 0 ? (
              <p className="text-sm text-muted">No messages found.</p>
            ) : (
              searchResults.map((m) => (
                <button
                  key={m.id}
                  onClick={() => jumpToResult(m)}
                  className="w-full text-left px-2 py-1.5 text-sm hover:bg-gray-50 rounded truncate"
                >
                  <span className="text-muted text-xs">{new Date(m.timestamp).toLocaleDateString()}</span>{" "}
                  <span>{m.sender_name ? `${m.sender_name}: ` : ""}{m.text?.slice(0, 80)}</span>
                </button>
              ))
            )}
          </div>
        )}

        {/* Messages */}
        <div ref={boxRef} onScroll={onScroll} className="flex-1 overflow-y-auto min-h-0 py-3" style={{ overflowAnchor: "none" }}>
          {msgs === undefined ? (
            <p className="text-center text-muted text-sm animate-pulse py-8">Loading messages…</p>
          ) : (
            <>
              {hasMore && <p className="text-center text-muted text-xs py-2">Loading older messages…</p>}
              {msgs.length === 0 && <p className="text-center text-muted text-sm py-8">No messages yet. Say hello!</p>}
              {msgs.map((m, i) => {
                const prev = msgs[i - 1];
                const newDay = !prev || new Date(prev.timestamp).toDateString() !== new Date(m.timestamp).toDateString();
                const showName = !prev || prev.from_me || prev.sender_name !== m.sender_name || newDay;
                return (
                  <Fragment key={m.client_id ?? m.id}>
                    {newDay && (
                      <div className="flex justify-center my-2">
                        <span className="text-xs bg-white/90 text-muted px-3 py-1 rounded-lg shadow-sm">{formatDay(m.timestamp)}</span>
                      </div>
                    )}
                    <div id={`msg-${m.id}`} className={`${showName ? "mt-2" : "mt-0.5"} ${highlightId === m.id ? "bg-yellow-100/70 transition-colors duration-1000" : ""}`}>
                      <Bubble msg={m} isGroup={!!chat?.is_group} showName={showName} accountId={accountId} />
                    </div>
                  </Fragment>
                );
              })}
              {typingParticipant !== undefined && typingParticipant !== null && (
                <div className="flex justify-start px-3 mt-2">
                  <div className="bg-bubble-theirs rounded-lg rounded-tl-none px-3 py-2 shadow-sm">
                    <div className="flex gap-1">
                      <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: "0ms" }} />
                      <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: "150ms" }} />
                      <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: "300ms" }} />
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <Composer accountId={accountId} chatId={chatId} disabled={account.status !== "connected"} isGroup={chat?.is_group} />
      </div>

      {showProfile && <ProfilePanel onClose={() => setShowProfile(false)} />}
    </div>
  );
}
