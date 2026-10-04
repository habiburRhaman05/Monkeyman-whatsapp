"use client";

import { useEffect, useState } from "react";
import { listStarred, type Chat, type Message } from "@/lib/api";
import { openMessage } from "@/lib/actions";
import { useStore } from "@/lib/store";
import { chatTitle, formatListTime } from "@/lib/util";

type Item = { message: Message; chat: Chat };

export default function StarredList({ accountId }: { accountId: number }) {
  const [items, setItems] = useState<Item[] | null>(null);
  // Re-fetch when a message is (un)starred while this tab is open
  const version = useStore((s) => Object.values(s.messages).reduce((n, list) => n + list.filter((m) => m.starred).length, 0));

  useEffect(() => {
    let alive = true;
    listStarred(accountId)
      .then((r) => alive && setItems(r))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [accountId, version]);

  if (items === null) return <p className="p-6 text-center text-muted text-sm animate-pulse">Loading…</p>;
  if (items.length === 0) {
    return <p className="p-6 text-center text-muted text-sm">No starred messages. Open a message&apos;s menu and choose Star.</p>;
  }
  return (
    <>
      {items.map(({ message, chat }) => (
        <button
          key={message.id}
          onClick={() => openMessage(accountId, chat.id, message.id)}
          className="w-full text-left px-3 py-2.5 border-b border-border/60 hover:bg-background"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate font-medium text-sm">
              {chatTitle(chat)}
              {message.from_me ? " · You" : message.sender_name ? ` · ${message.sender_name}` : ""}
            </span>
            <span className="text-xs text-muted shrink-0">{formatListTime(message.timestamp)}</span>
          </div>
          <div className="truncate text-sm text-muted">
            <span className="text-yellow-500">★</span> {message.text || `[${message.type}]`}
          </div>
        </button>
      ))}
    </>
  );
}
