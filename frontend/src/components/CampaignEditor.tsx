"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import * as api from "@/lib/api";

interface Props {
  campaignId: number | null;
  onClose: () => void;
  onSaved: () => void;
}

function genId() {
  return Math.random().toString(36).slice(2, 8);
}

const emptyMessage = (): api.CampaignNode => ({ id: genId(), type: "message", variants: [""] });
const emptyWait = (): api.CampaignNode => ({ id: genId(), type: "wait", amount: 1, unit: "hours", check_reply: false });
const emptyDrip = (): api.CampaignNode => ({ id: genId(), type: "drip", batch_size: 50, amount: 1, unit: "hours" });

export default function CampaignEditor({ campaignId, onClose, onSaved }: Props) {
  const accounts = useStore((s) => s.accounts);
  const labels = useStore((s) => s.labels);

  const [name, setName] = useState("New Campaign");
  const [triggerType, setTriggerType] = useState<"manual" | "tag_added">("manual");
  const [triggerLabelId, setTriggerLabelId] = useState<number | null>(null);
  const [senderIds, setSenderIds] = useState<number[]>([]);
  const [nodes, setNodes] = useState<api.CampaignNode[]>([emptyMessage()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(!campaignId);

  useEffect(() => {
    if (!campaignId) return;
    api.getCampaign(campaignId).then((c) => {
      setName(c.name);
      setTriggerType(c.trigger_type);
      setTriggerLabelId(c.trigger_label_id);
      setSenderIds(c.sender_account_ids);
      setNodes(c.nodes.length > 0 ? c.nodes : [emptyMessage()]);
      setLoaded(true);
    }).catch(() => setError("Failed to load campaign"));
  }, [campaignId]);

  function updateNode(idx: number, patch: Partial<api.CampaignNode>) {
    setNodes((prev) => prev.map((n, i) => (i === idx ? { ...n, ...patch } : n)));
  }

  function removeNode(idx: number) {
    setNodes((prev) => prev.filter((_, i) => i !== idx));
  }

  function moveNode(idx: number, dir: -1 | 1) {
    setNodes((prev) => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }

  function addVariant(nodeIdx: number) {
    setNodes((prev) =>
      prev.map((n, i) =>
        i === nodeIdx && n.type === "message" ? { ...n, variants: [...(n.variants || []), ""] } : n,
      ),
    );
  }

  function updateVariant(nodeIdx: number, vi: number, text: string) {
    setNodes((prev) =>
      prev.map((n, i) =>
        i === nodeIdx && n.type === "message"
          ? { ...n, variants: (n.variants || []).map((v, j) => (j === vi ? text : v)) }
          : n,
      ),
    );
  }

  function removeVariant(nodeIdx: number, vi: number) {
    setNodes((prev) =>
      prev.map((n, i) =>
        i === nodeIdx && n.type === "message"
          ? { ...n, variants: (n.variants || []).filter((_, j) => j !== vi) }
          : n,
      ),
    );
  }

  function toggleSender(id: number) {
    setSenderIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function handleSave() {
    setError("");
    setSaving(true);
    try {
      const body: api.CampaignBody = {
        name: name.trim(),
        trigger_type: triggerType,
        trigger_label_id: triggerType === "tag_added" ? triggerLabelId : null,
        sender_account_ids: senderIds,
        nodes,
      };
      if (campaignId) {
        await api.updateCampaign(campaignId, body);
      } else {
        await api.createCampaign(body);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof api.ApiError ? e.detail : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const nodeLabel = (type: string) =>
    type === "message" ? "Message" : type === "wait" ? "Wait" : "Drip";

  const nodeColor = (type: string) =>
    type === "message" ? "border-blue-300 bg-blue-50" : type === "wait" ? "border-yellow-300 bg-yellow-50" : "border-purple-300 bg-purple-50";

  if (!loaded) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/40" />
        <div className="relative bg-white rounded-xl shadow-xl p-8">
          <p className="text-muted animate-pulse">Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-xl mx-4 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <h2 className="font-semibold text-lg">{campaignId ? "Edit Campaign" : "New Campaign"}</h2>
          <button onClick={onClose} className="p-1 rounded-full hover:bg-gray-100 text-muted">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {error && <div className="px-3 py-2 text-sm bg-red-50 text-red-700 rounded-lg">{error}</div>}

          {/* Name */}
          <div>
            <label className="text-xs text-muted uppercase tracking-wider">Campaign name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              className="w-full mt-1 px-3 py-2 text-sm border border-border rounded-lg"
            />
          </div>

          {/* Trigger */}
          <div>
            <label className="text-xs text-muted uppercase tracking-wider">Trigger</label>
            <div className="flex gap-2 mt-1">
              <button
                onClick={() => setTriggerType("manual")}
                className={`px-3 py-1.5 text-sm rounded-lg border ${triggerType === "manual" ? "border-primary bg-primary/10 text-primary" : "border-border"}`}
              >
                Manual
              </button>
              <button
                onClick={() => setTriggerType("tag_added")}
                className={`px-3 py-1.5 text-sm rounded-lg border ${triggerType === "tag_added" ? "border-primary bg-primary/10 text-primary" : "border-border"}`}
              >
                Tag added
              </button>
            </div>
            {triggerType === "tag_added" && (
              <select
                value={triggerLabelId ?? ""}
                onChange={(e) => setTriggerLabelId(e.target.value ? Number(e.target.value) : null)}
                className="mt-2 w-full px-3 py-2 text-sm border border-border rounded-lg bg-white"
              >
                <option value="">Select a label…</option>
                {labels.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            )}
          </div>

          {/* Sender numbers */}
          <div>
            <label className="text-xs text-muted uppercase tracking-wider">Sender numbers</label>
            <p className="text-xs text-muted mt-0.5 mb-1">Contacts will be sticky-assigned to one of these numbers.</p>
            <div className="flex flex-wrap gap-2 mt-1">
              {accounts.filter((a) => a.status === "connected").map((a) => (
                <button
                  key={a.id}
                  onClick={() => toggleSender(a.id)}
                  className={`px-3 py-1.5 text-sm rounded-lg border ${senderIds.includes(a.id) ? "border-primary bg-primary/10 text-primary" : "border-border text-muted"}`}
                >
                  {a.label}{a.phone_number ? ` (${a.phone_number})` : ""}
                </button>
              ))}
              {accounts.filter((a) => a.status === "connected").length === 0 && (
                <span className="text-xs text-muted">No connected numbers</span>
              )}
            </div>
          </div>

          {/* Nodes */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-muted uppercase tracking-wider">Message flow</label>
              <div className="flex gap-1">
                <button onClick={() => setNodes([...nodes, emptyMessage()])} className="px-2 py-1 text-xs rounded border border-blue-300 text-blue-600 hover:bg-blue-50">+ Message</button>
                <button onClick={() => setNodes([...nodes, emptyWait()])} className="px-2 py-1 text-xs rounded border border-yellow-300 text-yellow-600 hover:bg-yellow-50">+ Wait</button>
                <button onClick={() => setNodes([...nodes, emptyDrip()])} className="px-2 py-1 text-xs rounded border border-purple-300 text-purple-600 hover:bg-purple-50">+ Drip</button>
              </div>
            </div>

            <div className="space-y-2">
              {nodes.map((node, ni) => (
                <div key={node.id} className={`border rounded-lg p-3 ${nodeColor(node.type)}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold uppercase">{nodeLabel(node.type)}</span>
                      <span className="text-xs text-muted">#{ni + 1}</span>
                    </div>
                    <div className="flex items-center gap-0.5">
                      <button onClick={() => moveNode(ni, -1)} disabled={ni === 0} className="p-1 rounded hover:bg-white/60 disabled:opacity-30 text-muted" title="Move up">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 15l-6-6-6 6" /></svg>
                      </button>
                      <button onClick={() => moveNode(ni, 1)} disabled={ni === nodes.length - 1} className="p-1 rounded hover:bg-white/60 disabled:opacity-30 text-muted" title="Move down">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 9l6 6 6-6" /></svg>
                      </button>
                      <button onClick={() => removeNode(ni)} className="p-1 rounded hover:bg-red-100 text-muted hover:text-red-500" title="Remove">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                      </button>
                    </div>
                  </div>

                  {node.type === "message" && (
                    <div className="space-y-2">
                      {(node.variants || [""]).map((v, vi) => (
                        <div key={vi} className="flex gap-1">
                          <textarea
                            value={v}
                            onChange={(e) => updateVariant(ni, vi, e.target.value)}
                            rows={2}
                            placeholder={`Variant ${vi + 1}…`}
                            className="flex-1 px-2 py-1.5 text-sm border border-border rounded-lg resize-y bg-white"
                          />
                          {(node.variants || []).length > 1 && (
                            <button onClick={() => removeVariant(ni, vi)} className="p-1 text-muted hover:text-red-500 self-start" title="Remove variant">
                              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                            </button>
                          )}
                        </div>
                      ))}
                      <button onClick={() => addVariant(ni)} className="text-xs text-blue-600 hover:underline">+ Add variant</button>
                      <p className="text-xs text-muted">Variants rotate round-robin per sender number for natural-looking messages.</p>
                    </div>
                  )}

                  {node.type === "wait" && (
                    <div className="flex items-center gap-2">
                      <span className="text-sm">Wait</span>
                      <input
                        type="number"
                        min={1}
                        value={node.amount ?? 1}
                        onChange={(e) => updateNode(ni, { amount: Math.max(1, Number(e.target.value)) })}
                        className="w-16 px-2 py-1 text-sm border border-border rounded-lg bg-white"
                      />
                      <select
                        value={node.unit ?? "hours"}
                        onChange={(e) => updateNode(ni, { unit: e.target.value as "minutes" | "hours" | "days" })}
                        className="px-2 py-1 text-sm border border-border rounded-lg bg-white"
                      >
                        <option value="minutes">minutes</option>
                        <option value="hours">hours</option>
                        <option value="days">days</option>
                      </select>
                      <label className="flex items-center gap-1 text-xs text-muted ml-2">
                        <input
                          type="checkbox"
                          checked={!!node.check_reply}
                          onChange={(e) => updateNode(ni, { check_reply: e.target.checked })}
                        />
                        Skip if replied
                      </label>
                    </div>
                  )}

                  {node.type === "drip" && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm">Send</span>
                        <input
                          type="number"
                          min={1}
                          max={200}
                          value={node.batch_size ?? 50}
                          onChange={(e) => updateNode(ni, { batch_size: Math.max(1, Math.min(200, Number(e.target.value))) })}
                          className="w-16 px-2 py-1 text-sm border border-border rounded-lg bg-white"
                        />
                        <span className="text-sm">per number, every</span>
                        <input
                          type="number"
                          min={1}
                          value={node.amount ?? 1}
                          onChange={(e) => updateNode(ni, { amount: Math.max(1, Number(e.target.value)) })}
                          className="w-16 px-2 py-1 text-sm border border-border rounded-lg bg-white"
                        />
                        <select
                          value={node.unit ?? "hours"}
                          onChange={(e) => updateNode(ni, { unit: e.target.value as "minutes" | "hours" | "days" })}
                          className="px-2 py-1 text-sm border border-border rounded-lg bg-white"
                        >
                          <option value="minutes">minutes</option>
                          <option value="hours">hours</option>
                          <option value="days">days</option>
                        </select>
                      </div>
                      <p className="text-xs text-muted">Rate-limits how many contacts proceed past this point per number per interval. Max 200/day per number for safety.</p>
                    </div>
                  )}
                </div>
              ))}

              {nodes.length === 0 && (
                <p className="text-sm text-muted text-center py-4">Add at least one Message node to build your flow.</p>
              )}
            </div>
          </div>

          {/* Safety note */}
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2 text-xs text-yellow-800">
            <strong>Safety:</strong> Max 200 messages/day per sender number. Random 10-30s delay between sends. No auto-retry on failure. These limits protect your numbers from being flagged.
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-gray-50">Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving || !name.trim()}
            className="px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary-dark disabled:opacity-50"
          >
            {saving ? "Saving…" : campaignId ? "Save changes" : "Create campaign"}
          </button>
        </div>
      </div>
    </div>
  );
}
