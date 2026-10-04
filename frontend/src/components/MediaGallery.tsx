"use client";

import { useEffect, useState } from "react";
import { getGallery, type GalleryKind, type GalleryMessage } from "@/lib/api";
import { openMessage } from "@/lib/actions";
import { formatDay } from "@/lib/util";
import { Media } from "./Bubble";

const TABS: { id: GalleryKind; label: string }[] = [
  { id: "media", label: "Media" },
  { id: "docs", label: "Docs" },
  { id: "links", label: "Links" },
];

function GalleryList({ accountId, chatId, kind }: { accountId: number; chatId: number; kind: GalleryKind }) {
  const [items, setItems] = useState<GalleryMessage[] | null>(null);

  useEffect(() => {
    let alive = true;
    getGallery(accountId, chatId, kind)
      .then((r) => alive && setItems(r.messages))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [accountId, chatId, kind]);

  if (items === null) return <p className="p-6 text-center text-muted text-sm animate-pulse">Loading…</p>;
  if (items.length === 0) {
    return <p className="p-6 text-center text-muted text-sm">No {kind === "media" ? "photos or videos" : kind === "docs" ? "documents" : "links"} in this chat.</p>;
  }

  return (
    <div className={kind === "media" ? "grid grid-cols-2 gap-2 p-3" : "divide-y divide-border/60"}>
      {items.map((m) => (
        <div key={m.id} className={kind === "media" ? "rounded-lg border border-border p-2 min-w-0" : "px-4 py-2.5 min-w-0"}>
          {kind === "links" ? (
            <div className="space-y-0.5">
              {m.links?.map((u) => (
                <a key={u} href={u} target="_blank" rel="noopener noreferrer" className="block truncate text-sm text-sky-600 hover:underline">
                  {u}
                </a>
              ))}
            </div>
          ) : (
            <Media msg={m} />
          )}
          <button
            onClick={() => openMessage(accountId, chatId, m.id)}
            className="mt-1 text-[11px] text-muted hover:text-primary"
            title="Show in chat"
          >
            {m.from_me ? "You" : m.sender_name || "Them"} · {formatDay(m.timestamp)}
          </button>
        </div>
      ))}
    </div>
  );
}

export default function MediaGallery({ accountId, chatId }: { accountId: number; chatId: number }) {
  const [kind, setKind] = useState<GalleryKind>("media");
  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="flex border-b border-border shrink-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setKind(t.id)}
            className={`flex-1 py-2 text-sm border-b-2 ${
              kind === t.id ? "border-primary text-primary font-medium" : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        <GalleryList key={`${chatId}-${kind}`} accountId={accountId} chatId={chatId} kind={kind} />
      </div>
    </div>
  );
}
