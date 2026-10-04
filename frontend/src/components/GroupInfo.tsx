"use client";

import { useEffect, useState } from "react";
import { ApiError, getGroupInfo, leaveGroup, type GroupInfo as Info } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Avatar } from "./ChatList";

export default function GroupInfo({ accountId, chatId }: { accountId: number; chatId: number }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getGroupInfo(accountId, chatId)
      .then((r) => alive && setInfo(r))
      .catch((e) => alive && setError(e instanceof ApiError ? e.detail : "Could not load group info"));
    return () => {
      alive = false;
    };
  }, [accountId, chatId]);

  async function leave() {
    if (!window.confirm("Leave this group? You will stop receiving its messages.")) return;
    try {
      await leaveGroup(accountId, chatId);
      useStore.getState().pushToast({ kind: "info", title: "You left the group" });
    } catch (e) {
      useStore.getState().pushToast({ kind: "error", title: "Could not leave the group", body: e instanceof ApiError ? e.detail : undefined });
    }
  }

  if (error) return <p className="text-sm text-muted">{error}</p>;
  if (!info) return <p className="text-sm text-muted animate-pulse">Loading group…</p>;

  return (
    <div className="space-y-4">
      {info.description && (
        <div>
          <div className="text-xs text-muted uppercase tracking-wider mb-1">Description</div>
          <p className="text-sm whitespace-pre-wrap break-words">{info.description}</p>
        </div>
      )}
      <div>
        <div className="text-xs text-muted uppercase tracking-wider mb-1">{info.participants.length} members</div>
        <ul className="space-y-1.5">
          {info.participants.map((p) => {
            const title = p.name || (p.phone ? `+${p.phone}` : "WhatsApp user");
            return (
              <li key={p.jid} className="flex items-center gap-2.5">
                <Avatar name={title} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate">{title}</div>
                  {p.name && p.phone && <div className="text-[11px] text-muted">+{p.phone}</div>}
                </div>
                {p.admin && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded border border-primary/40 text-primary shrink-0">
                    {p.admin === "superadmin" ? "Owner" : "Admin"}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <button onClick={leave} className="w-full py-2 text-sm rounded-lg border border-danger/40 text-danger hover:bg-danger/5">
        Leave group
      </button>
    </div>
  );
}
