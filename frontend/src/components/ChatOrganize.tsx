"use client";

import { useState } from "react";
import type { Chat } from "@/lib/api";
import { useStore } from "@/lib/store";
import { addLabel, removeLabel, setChatFlags, toggleChatLabel } from "@/lib/actions";

function NoteBox({ chat }: { chat: Chat }) {
  const [text, setText] = useState(chat.note ?? "");
  return (
    <textarea
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text.trim() !== (chat.note ?? "") && setChatFlags(chat, { note: text })}
      rows={3}
      maxLength={4000}
      placeholder="Private note about this chat (only you see it)"
      className="w-full text-sm px-2.5 py-2 rounded-lg bg-background resize-y focus:outline-none focus:ring-2 focus:ring-primary"
    />
  );
}

/** Labels and a private note. Both live in this dashboard only; WhatsApp never sees them. */
export default function ChatOrganize({ chat }: { chat: Chat }) {
  const labels = useStore((s) => s.labels);

  async function newLabel() {
    const name = window.prompt("New label name:")?.trim();
    if (!name) return;
    const lb = await addLabel(name);
    if (lb) toggleChatLabel(useStore.getState().chats[chat.account_id]?.find((c) => c.id === chat.id) ?? chat, lb.id);
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-muted uppercase tracking-wider mb-1.5">Labels</div>
        <div className="flex flex-wrap gap-1.5">
          {labels.map((lb) => {
            const on = chat.label_ids.includes(lb.id);
            return (
              <span
                key={lb.id}
                className="group inline-flex items-center rounded-full border text-xs overflow-hidden"
                style={{ borderColor: lb.color, background: on ? lb.color : "transparent", color: on ? "#fff" : lb.color }}
              >
                <button onClick={() => toggleChatLabel(chat, lb.id)} className="pl-2.5 pr-2 py-1" title={on ? "Remove from this chat" : "Add to this chat"}>
                  {lb.name}
                </button>
                <button
                  onClick={() => window.confirm(`Delete the label "${lb.name}" from all chats?`) && removeLabel(lb.id)}
                  className="pr-2 py-1 opacity-0 group-hover:opacity-80 hover:!opacity-100"
                  title="Delete label"
                  aria-label={`Delete label ${lb.name}`}
                >
                  ×
                </button>
              </span>
            );
          })}
          <button onClick={newLabel} className="px-2.5 py-1 rounded-full border border-dashed border-border text-xs text-muted hover:text-primary hover:border-primary">
            + New label
          </button>
        </div>
      </div>
      <div>
        <div className="text-xs text-muted uppercase tracking-wider mb-1.5">Note</div>
        <NoteBox key={chat.id} chat={chat} />
      </div>
    </div>
  );
}
