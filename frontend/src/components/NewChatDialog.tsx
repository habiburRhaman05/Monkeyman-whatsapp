"use client";

import { useState } from "react";
import { openChatWith, sendTextMessage } from "@/lib/actions";
import { newClientId } from "@/lib/util";

export default function NewChatDialog({ accountId, onClose }: { accountId: number; onClose: () => void }) {
  const [number, setNumber] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const digits = number.replace(/\D/g, "");
  const valid = digits.length >= 6 && digits.length <= 15;

  async function start() {
    if (!valid || busy) return;
    setBusy(true);
    const chatId = await openChatWith(accountId, digits);
    if (chatId && text.trim()) {
      await sendTextMessage(accountId, chatId, text.trim(), newClientId());
    }
    setBusy(false);
    if (chatId) onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-surface rounded-xl shadow-xl p-5 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-3">New chat</h2>

        <label className="block text-sm font-medium mb-1">Phone number with country code</label>
        <input
          autoFocus
          inputMode="tel"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="e.g. 14155550123"
          className="w-full px-3 py-2 border border-border rounded-lg bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
        {number && !valid && <p className="text-danger text-xs mt-1">Use 6–15 digits including the country code.</p>}

        <label className="block text-sm font-medium mt-3 mb-1">First message (optional)</label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          className="w-full px-3 py-2 border border-border rounded-lg bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary resize-none"
        />

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg border border-border hover:bg-background text-sm">
            Cancel
          </button>
          <button
            onClick={start}
            disabled={!valid || busy}
            className="flex-1 py-2 rounded-lg bg-primary text-white hover:bg-primary-dark disabled:opacity-50 text-sm font-medium"
          >
            {busy ? "Starting…" : text.trim() ? "Send" : "Open chat"}
          </button>
        </div>
      </div>
    </div>
  );
}
