"use client";

import { useCallback, useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import * as api from "@/lib/api";
import CampaignEditor from "./CampaignEditor";

export default function CampaignsTab() {
  const campaigns = useStore((s) => s.campaigns);
  const accounts = useStore((s) => s.accounts);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      useStore.getState().setCampaigns(await api.listCampaigns());
    } catch {} finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleDelete(id: number) {
    if (!window.confirm("Delete this campaign and all its run history?")) return;
    try {
      await api.deleteCampaign(id);
      load();
    } catch {}
  }

  async function toggleStatus(c: api.Campaign) {
    try {
      const next = c.status === "active" ? "paused" : "active";
      await api.setCampaignStatus(c.id, next);
      load();
    } catch (e) {
      alert(e instanceof api.ApiError ? e.detail : "Failed");
    }
  }

  const statusBadge = (s: string) => {
    const cls =
      s === "active" ? "bg-green-100 text-green-700" :
      s === "paused" ? "bg-yellow-100 text-yellow-700" :
      "bg-gray-100 text-gray-500";
    return <span className={`text-xs px-2 py-0.5 rounded-full ${cls}`}>{s}</span>;
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 border-b border-border/60 flex items-center justify-between">
        <span className="text-sm font-medium text-muted">{campaigns.length} campaign{campaigns.length !== 1 ? "s" : ""}</span>
        <button
          onClick={() => setShowNew(true)}
          className="px-3 py-1.5 text-sm bg-primary text-white rounded-lg hover:bg-primary-dark"
        >
          + New
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {loading && campaigns.length === 0 ? (
          <p className="p-6 text-center text-muted text-sm animate-pulse">Loading…</p>
        ) : campaigns.length === 0 ? (
          <p className="p-6 text-center text-muted text-sm">
            No campaigns yet. Create one to set up automated message sequences.
          </p>
        ) : (
          campaigns.map((c) => {
            const msgNodes = c.nodes.filter((n) => n.type === "message").length;
            const senderCount = c.sender_account_ids.length;
            const senderNames = c.sender_account_ids
              .map((id) => accounts.find((a) => a.id === id)?.label || `#${id}`)
              .join(", ");

            return (
              <div key={c.id} className="border-b border-border/60 hover:bg-background px-3 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <button
                        onClick={() => setEditingId(c.id)}
                        className="font-medium text-sm truncate hover:underline text-left"
                      >
                        {c.name}
                      </button>
                      {statusBadge(c.status)}
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
                      <span>{msgNodes} message{msgNodes !== 1 ? "s" : ""} · {c.nodes.length} node{c.nodes.length !== 1 ? "s" : ""}</span>
                      <span>{c.trigger_type === "tag_added" ? "Tag trigger" : "Manual"}</span>
                      {senderCount > 0 && <span title={senderNames}>{senderCount} sender{senderCount !== 1 ? "s" : ""}</span>}
                    </div>
                    {c.counts && c.counts.total > 0 && (
                      <div className="flex gap-2 mt-1 text-xs">
                        <span className="text-blue-600">{c.counts.active} active</span>
                        <span className="text-green-600">{c.counts.completed} done</span>
                        {c.counts.replied > 0 && <span className="text-teal-600">{c.counts.replied} replied</span>}
                        {c.counts.failed > 0 && <span className="text-red-500">{c.counts.failed} failed</span>}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {c.status !== "active" && c.nodes.length > 0 && (
                      <button
                        onClick={() => toggleStatus(c)}
                        title="Activate"
                        className="p-1.5 rounded-lg hover:bg-green-50 text-green-600"
                      >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                      </button>
                    )}
                    {c.status === "active" && (
                      <button
                        onClick={() => toggleStatus(c)}
                        title="Pause"
                        className="p-1.5 rounded-lg hover:bg-yellow-50 text-yellow-600"
                      >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z" /></svg>
                      </button>
                    )}
                    <button
                      onClick={() => setEditingId(c.id)}
                      title="Edit"
                      className="p-1.5 rounded-lg hover:bg-gray-100 text-muted"
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleDelete(c.id)}
                      title="Delete"
                      className="p-1.5 rounded-lg hover:bg-red-50 text-muted hover:text-red-500"
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {(showNew || editingId !== null) && (
        <CampaignEditor
          campaignId={editingId}
          onClose={() => { setEditingId(null); setShowNew(false); }}
          onSaved={() => { setEditingId(null); setShowNew(false); load(); }}
        />
      )}
    </div>
  );
}
