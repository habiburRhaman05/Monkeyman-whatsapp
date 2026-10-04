"use client";

import { useState } from "react";
import { useStore } from "@/lib/store";
import { addQuickReply, removeQuickReply } from "@/lib/actions";

export default function QuickRepliesDialog({ onPick, onClose }: { onPick: (text: string) => void; onClose: () => void }) {
  const replies = useStore((s) => s.quickReplies);
  const [shortcut, setShortcut] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!shortcut.trim() || !text.trim() || saving) return;
    setSaving(true);
    const ok = await addQuickReply(shortcut, text);
    setSaving(false);
    if (ok) {
      setShortcut("");
      setText("");
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="font-semibold">Quick replies</h2>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded-full hover:bg-background">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {replies.length === 0 ? (
            <p className="p-5 text-sm text-muted text-center">No quick replies yet. Add one below, then type /shortcut in any chat.</p>
          ) : (
            replies.map((r) => (
              <div key={r.id} className="flex items-start gap-2 px-4 py-2.5 border-b border-border/60">
                <button onClick={() => { onPick(r.text); onClose(); }} className="flex-1 min-w-0 text-left" title="Insert into the message box">
                  <div className="text-sm font-medium text-primary">/{r.shortcut}</div>
                  <div className="text-sm text-muted line-clamp-2 break-words">{r.text}</div>
                </button>
                <button
                  onClick={() => removeQuickReply(r.id)}
                  className="text-xs text-muted hover:text-danger shrink-0 pt-0.5"
                  aria-label={`Delete /${r.shortcut}`}
                >
                  Delete
                </button>
              </div>
            ))
          )}
        </div>

        <div className="p-4 border-t border-border space-y-2">
          <div className="flex items-center gap-1">
            <span className="text-muted">/</span>
            <input
              value={shortcut}
              onChange={(e) => setShortcut(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ""))}
              maxLength={40}
              placeholder="shortcut (e.g. thanks)"
              className="flex-1 px-3 py-2 text-sm rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            maxLength={4000}
            placeholder="Message text"
            className="w-full px-3 py-2 text-sm rounded-lg bg-background resize-y focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <button
            onClick={save}
            disabled={!shortcut.trim() || !text.trim() || saving}
            className="w-full py-2 text-sm rounded-lg bg-primary text-white hover:bg-primary-dark disabled:opacity-50"
          >
            Save quick reply
          </button>
        </div>
      </div>
    </div>
  );
}
