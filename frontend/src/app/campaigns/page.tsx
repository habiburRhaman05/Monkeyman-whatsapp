"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import * as api from "@/lib/api";
import VariablePills from "@/components/VariablePills";

function genId() {
  return Math.random().toString(36).slice(2, 8);
}
const newMsg = (): api.CampaignNode => ({ id: genId(), type: "message", variants: [""] });
const newWait = (): api.CampaignNode => ({ id: genId(), type: "wait", amount: 1, unit: "hours", check_reply: false });
const newDrip = (): api.CampaignNode => ({ id: genId(), type: "drip", batch_size: 50, amount: 1, unit: "hours" });

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "active" ? "bg-green-100 text-green-700" :
    status === "paused" ? "bg-yellow-100 text-yellow-700" :
    status === "completed" ? "bg-blue-100 text-blue-700" :
    "bg-gray-100 text-gray-500";
  return <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${cls}`}>{status}</span>;
}

/* ── SVG connector between nodes ──────────────────────── */
function Connector({ hasAdd, onAdd }: { hasAdd?: boolean; onAdd?: (type: "message" | "wait" | "drip") => void }) {
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showMenu) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showMenu]);

  return (
    <div className="flex flex-col items-center relative" style={{ height: 48 }}>
      <svg width="2" height="48" className="text-gray-300">
        <line x1="1" y1="0" x2="1" y2="48" stroke="currentColor" strokeWidth="2" strokeDasharray="4 3" />
      </svg>
      <svg width="10" height="8" className="text-gray-300 absolute bottom-0" style={{ transform: "translateY(2px)" }}>
        <polygon points="5,8 0,0 10,0" fill="currentColor" />
      </svg>
      {hasAdd && (
        <div ref={menuRef} className={`absolute top-1/2 -translate-y-1/2 ${showMenu ? "z-[999]" : "z-10"}`}>
          <button
            onClick={() => setShowMenu(!showMenu)}
            className="w-6 h-6 rounded-full bg-white border-2 border-gray-300 hover:border-primary hover:text-primary text-gray-400 flex items-center justify-center text-xs font-bold shadow-sm transition-colors"
          >
            +
          </button>
          {showMenu && onAdd && (
            <div className="absolute left-8 top-1/2 -translate-y-1/2 z-20 bg-white rounded-xl shadow-xl border border-border py-1.5 min-w-[150px]">
              {[
                { type: "message" as const, label: "Message", icon: "💬", color: "text-blue-600" },
                { type: "wait" as const, label: "Wait / Delay", icon: "⏳", color: "text-yellow-600" },
                { type: "drip" as const, label: "Drip Gate", icon: "🚿", color: "text-purple-600" },
              ].map((item) => (
                <button
                  key={item.type}
                  onClick={() => { onAdd(item.type); setShowMenu(false); }}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center gap-2 ${item.color}`}
                >
                  <span>{item.icon}</span>
                  <span className="font-medium">{item.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Workflow node icons ──────────────────────────────── */
const NodeIcon = ({ type }: { type: string }) => {
  if (type === "message") return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>
  );
  if (type === "wait") return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
  );
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 2v6M12 18v4M4.93 4.93l4.24 4.24M14.83 14.83l4.24 4.24M2 12h6M18 12h4M4.93 19.07l4.24-4.24M14.83 9.17l4.24-4.24" /></svg>
  );
};

const NODE_STYLES = {
  message: { border: "border-blue-200", bg: "bg-gradient-to-br from-blue-50 to-white", accent: "bg-blue-500", ring: "ring-blue-200", text: "text-blue-700" },
  wait: { border: "border-amber-200", bg: "bg-gradient-to-br from-amber-50 to-white", accent: "bg-amber-500", ring: "ring-amber-200", text: "text-amber-700" },
  drip: { border: "border-purple-200", bg: "bg-gradient-to-br from-purple-50 to-white", accent: "bg-purple-500", ring: "ring-purple-200", text: "text-purple-700" },
};

export default function CampaignsPage() {
  const campaigns = useStore((s) => s.campaigns);
  const accounts = useStore((s) => s.accounts);
  const labels = useStore((s) => s.labels);

  const [loading, setLoading] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  // Editor state
  const [name, setName] = useState("New Campaign");
  const [triggerType, setTriggerType] = useState<"manual" | "tag_added">("manual");
  const [triggerLabelId, setTriggerLabelId] = useState<number | null>(null);
  const [senderIds, setSenderIds] = useState<number[]>([]);
  const [nodes, setNodes] = useState<api.CampaignNode[]>([newMsg()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [selectedNode, setSelectedNode] = useState<number | null>(null);
  const [editorTab, setEditorTab] = useState<"builder" | "enroll" | "logs">("builder");

  // Enroll state
  const [enrollBatchId, setEnrollBatchId] = useState<number | null>(null);
  const [enrollContacts, setEnrollContacts] = useState<api.UploadedContact[]>([]);
  const [enrollSelected, setEnrollSelected] = useState<Set<number>>(new Set());
  const [enrollLoading, setEnrollLoading] = useState(false);
  const [enrollResult, setEnrollResult] = useState<{ enrolled: number; skipped: number } | null>(null);
  const [batches, setBatches] = useState<api.ContactBatch[]>([]);

  // Logs state
  const [runs, setRuns] = useState<api.CampaignRun[]>([]);
  const [runsTotal, setRunsTotal] = useState(0);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runEvents, setRunEvents] = useState<Record<number, api.CampaignEvent[]>>({});
  const [expandedRun, setExpandedRun] = useState<number | null>(null);
  const [logsFilter, setLogsFilter] = useState<string>("");

  // Template variables
  const BUILTIN_FIELDS = ["first_name", "name", "company", "email", "phone", "whatsapp_copy"];
  const [contactFields, setContactFields] = useState<string[]>(BUILTIN_FIELDS);
  const taRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const canvasRef = useRef<HTMLDivElement>(null);
  const configPanelRef = useRef<HTMLDivElement>(null);

  const editorOpen = editId !== null || creating;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      useStore.getState().setCampaigns(await api.listCampaigns());
    } catch {} finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    if (labels.length === 0) api.listLabels().then((l) => useStore.getState().setLabels(l)).catch(() => {});
    api.listContactFields()
      .then((r) => {
        const merged = [...BUILTIN_FIELDS];
        for (const f of r.fields) { if (!merged.includes(f)) merged.push(f); }
        setContactFields(merged);
      })
      .catch(() => {});
  }, [load, labels.length]);

  async function loadBatches() {
    try { setBatches(await api.listBatches()); } catch {}
  }
  async function loadEnrollContacts(batchId: number) {
    setEnrollLoading(true);
    try {
      const r = await api.listUploadedContacts({ batch_id: batchId, limit: 500 });
      setEnrollContacts(r.contacts);
      setEnrollSelected(new Set(r.contacts.map((c) => c.id)));
    } catch {} finally { setEnrollLoading(false); }
  }
  async function doEnroll() {
    if (!editId || enrollSelected.size === 0) return;
    setEnrollLoading(true); setEnrollResult(null);
    try {
      const r = await api.enrollContacts(editId, { contact_ids: Array.from(enrollSelected) });
      setEnrollResult(r);
      load();
    } catch (e) { setError(e instanceof api.ApiError ? e.detail : "Enroll failed"); }
    finally { setEnrollLoading(false); }
  }
  async function loadRuns(campaignId: number) {
    setRunsLoading(true);
    try {
      const r = await api.listCampaignRuns(campaignId, { limit: 200 });
      setRuns(r.runs); setRunsTotal(r.total);
    } catch {} finally { setRunsLoading(false); }
  }
  async function loadRunEvents(campaignId: number, runId: number) {
    try {
      const r = await api.listCampaignEvents(campaignId, { run_id: runId, limit: 50 });
      setRunEvents((prev) => ({ ...prev, [runId]: r.events }));
    } catch {}
  }

  function resetEditor() {
    setName("New Campaign"); setTriggerType("manual"); setTriggerLabelId(null);
    setSenderIds([]); setNodes([newMsg()]); setError(""); setSelectedNode(null);
    setEditorTab("builder"); setEnrollResult(null); setRuns([]); setExpandedRun(null);
  }
  function openNew() { resetEditor(); setEditId(null); setCreating(true); }
  async function openEdit(id: number) {
    setCreating(false); setError(""); setSelectedNode(null);
    try {
      const c = await api.getCampaign(id);
      setEditId(c.id); setName(c.name); setTriggerType(c.trigger_type);
      setTriggerLabelId(c.trigger_label_id); setSenderIds(c.sender_account_ids);
      setNodes(c.nodes.length > 0 ? c.nodes : [newMsg()]);
    } catch { setError("Failed to load campaign"); }
  }
  function closeEditor() { setEditId(null); setCreating(false); resetEditor(); }

  // Node mutations
  function updateNode(idx: number, patch: Partial<api.CampaignNode>) {
    setNodes((p) => p.map((n, i) => (i === idx ? { ...n, ...patch } : n)));
  }
  function removeNode(idx: number) {
    setNodes((p) => p.filter((_, i) => i !== idx));
    if (selectedNode === idx) setSelectedNode(null);
    else if (selectedNode !== null && selectedNode > idx) setSelectedNode(selectedNode - 1);
  }
  function moveNode(idx: number, dir: -1 | 1) {
    setNodes((p) => {
      const next = [...p]; const t = idx + dir;
      if (t < 0 || t >= next.length) return p;
      [next[idx], next[t]] = [next[t], next[idx]]; return next;
    });
    if (selectedNode === idx) setSelectedNode(idx + dir);
  }
  function insertNodeAfter(idx: number, type: "message" | "wait" | "drip") {
    const factory = type === "message" ? newMsg : type === "wait" ? newWait : newDrip;
    setNodes((p) => [...p.slice(0, idx + 1), factory(), ...p.slice(idx + 1)]);
  }
  function addVariant(ni: number) {
    setNodes((p) => p.map((n, i) => i === ni && n.type === "message" ? { ...n, variants: [...(n.variants || []), ""] } : n));
  }
  function updateVariant(ni: number, vi: number, text: string) {
    setNodes((p) => p.map((n, i) => i === ni && n.type === "message" ? { ...n, variants: (n.variants || []).map((v, j) => j === vi ? text : v) } : n));
  }
  function removeVariant(ni: number, vi: number) {
    setNodes((p) => p.map((n, i) => i === ni && n.type === "message" ? { ...n, variants: (n.variants || []).filter((_, j) => j !== vi) } : n));
  }
  function insertVariable(ni: number, vi: number, varName: string) {
    const node = nodes[ni];
    const current = node?.type === "message" ? (node.variants?.[vi] ?? "") : "";
    const token = `{{${varName}}}`;
    const ta = taRefs.current[`${ni}-${vi}`];
    let next: string; let caret: number;
    if (ta) {
      const start = ta.selectionStart ?? current.length; const end = ta.selectionEnd ?? start;
      next = current.slice(0, start) + token + current.slice(end); caret = start + token.length;
    } else { next = current + token; caret = next.length; }
    updateVariant(ni, vi, next);
    requestAnimationFrame(() => { const el = taRefs.current[`${ni}-${vi}`]; if (el) { el.focus(); el.setSelectionRange(caret, caret); } });
  }

  async function handleSave() {
    setError(""); setSaving(true);
    try {
      const body: api.CampaignBody = { name: name.trim(), trigger_type: triggerType, trigger_label_id: triggerType === "tag_added" ? triggerLabelId : null, sender_account_ids: senderIds, nodes };
      if (editId) await api.updateCampaign(editId, body); else await api.createCampaign(body);
      closeEditor(); load();
    } catch (e) { setError(e instanceof api.ApiError ? e.detail : "Save failed"); }
    finally { setSaving(false); }
  }
  async function handleDelete(id: number) {
    if (!window.confirm("Delete this campaign and all its run history?")) return;
    try { await api.deleteCampaign(id); if (editId === id) closeEditor(); load(); } catch {}
  }
  async function toggleStatus(c: api.Campaign) {
    try { await api.setCampaignStatus(c.id, c.status === "active" ? "paused" : "active"); load(); }
    catch (e) { alert(e instanceof api.ApiError ? e.detail : "Failed"); }
  }

  return (
    <div className="h-dvh flex flex-col bg-gray-50/30">
      {/* Header */}
      <header className="bg-header-bg text-header-text px-4 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm px-3 py-1.5 rounded-full bg-white/15 hover:bg-white/25 transition-colors">← Chats</Link>
          <h1 className="text-lg font-semibold">Campaigns</h1>
        </div>
        <button onClick={openNew} className="px-4 py-2 bg-white/20 hover:bg-white/30 text-white rounded-lg text-sm font-medium flex items-center gap-2 transition-colors">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          New Campaign
        </button>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* Left: campaign list */}
        <aside className={`${editorOpen ? "hidden lg:flex" : "flex"} w-full lg:w-80 border-r border-border bg-white flex-col min-h-0 shrink-0`}>
          <div className="px-4 py-3 border-b border-border/60 flex items-center justify-between">
            <span className="text-sm font-medium text-muted">{campaigns.length} campaign{campaigns.length !== 1 ? "s" : ""}</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading && campaigns.length === 0 ? (
              <p className="p-6 text-center text-muted text-sm animate-pulse">Loading…</p>
            ) : campaigns.length === 0 ? (
              <div className="p-6 text-center">
                <div className="mx-auto w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center mb-3">
                  <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-muted/40"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
                </div>
                <p className="text-muted text-sm mb-3">No campaigns yet.</p>
                <button onClick={openNew} className="px-4 py-2 bg-primary text-white rounded-lg text-sm hover:bg-primary-dark font-medium">
                  Create your first campaign
                </button>
              </div>
            ) : (
              campaigns.map((c) => {
                const msgCount = c.nodes.filter((n) => n.type === "message").length;
                return (
                  <div key={c.id} onClick={() => openEdit(c.id)}
                    className={`group border-b border-border/60 hover:bg-gray-50 px-4 py-3 cursor-pointer transition-colors ${editId === c.id ? "bg-primary/5 border-l-2 border-l-primary" : ""}`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="font-medium text-sm truncate">{c.name}</span>
                      <StatusBadge status={c.status} />
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted">
                      <span>{msgCount} msg · {c.nodes.length} steps</span>
                      <span>{c.trigger_type === "tag_added" ? "Tag trigger" : "Manual"}</span>
                    </div>
                    {c.counts && c.counts.total > 0 && (
                      <div className="flex gap-2 mt-1 text-xs">
                        {c.counts.active > 0 && <span className="text-blue-600">{c.counts.active} active</span>}
                        <span className="text-green-600">{c.counts.completed} done</span>
                        {c.counts.replied > 0 && <span className="text-teal-600">{c.counts.replied} replied</span>}
                        {c.counts.failed > 0 && <span className="text-red-500">{c.counts.failed} failed</span>}
                      </div>
                    )}
                    <div className="flex gap-1 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      {(c.status === "draft" || c.status === "paused") && c.nodes.length > 0 && (
                        <button onClick={(e) => { e.stopPropagation(); toggleStatus(c); }} className="px-2 py-1 text-xs rounded bg-green-50 text-green-700 hover:bg-green-100">Activate</button>
                      )}
                      {c.status === "active" && (
                        <button onClick={(e) => { e.stopPropagation(); toggleStatus(c); }} className="px-2 py-1 text-xs rounded bg-yellow-50 text-yellow-700 hover:bg-yellow-100">⏸ Pause</button>
                      )}
                      <button onClick={(e) => { e.stopPropagation(); handleDelete(c.id); }} className="px-2 py-1 text-xs rounded bg-red-50 text-red-600 hover:bg-red-100">Delete</button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* Right: workflow builder */}
        <main className={`${editorOpen ? "flex" : "hidden lg:flex"} flex-1 flex-col min-h-0 min-w-0`}>
          {!editorOpen ? (
            <div className="flex-1 flex items-center justify-center bg-[radial-gradient(circle_at_center,rgba(0,0,0,0.02)_1px,transparent_1px)] bg-[length:20px_20px]">
              <div className="text-center">
                <div className="mx-auto w-16 h-16 rounded-2xl bg-gray-100 flex items-center justify-center mb-3">
                  <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-muted/40"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
                </div>
                <p className="text-muted text-sm">Select a campaign to edit, or create a new one.</p>
              </div>
            </div>
          ) : (
            <>
              {/* Editor toolbar */}
              <div className="px-4 py-2.5 border-b border-border flex items-center justify-between bg-white shrink-0">
                <div className="flex items-center gap-3">
                  <button onClick={closeEditor} className="lg:hidden p-1.5 rounded-lg hover:bg-gray-100 text-muted">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6" /></svg>
                  </button>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={120}
                    className="font-semibold text-base bg-transparent border-none focus:outline-none focus:ring-0 w-auto min-w-[200px]"
                    placeholder="Campaign name…"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted hidden sm:block">{nodes.length} step{nodes.length !== 1 ? "s" : ""}</span>
                  <button onClick={closeEditor} className="px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-gray-50 transition-colors">Cancel</button>
                  <button onClick={handleSave} disabled={saving || !name.trim()} className="px-4 py-1.5 text-sm bg-primary text-white rounded-lg hover:bg-primary-dark disabled:opacity-50 font-medium transition-colors">
                    {saving ? "Saving…" : editId ? "Save" : "Create"}
                  </button>
                </div>
              </div>

              {error && <div className="mx-4 mt-2 px-3 py-2 text-sm bg-red-50 text-red-700 rounded-lg border border-red-100">{error}</div>}

              {/* Tabs */}
              <div className="px-4 border-b border-border bg-white shrink-0 flex gap-0">
                {(["builder", "enroll", "logs"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => {
                      setEditorTab(t);
                      if (t === "enroll") { loadBatches(); }
                      if (t === "logs" && editId) { loadRuns(editId); }
                    }}
                    className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${editorTab === t ? "border-primary text-primary" : "border-transparent text-muted hover:text-foreground"}`}
                  >
                    {t === "builder" ? "Builder" : t === "enroll" ? "Enroll Contacts" : "Logs"}
                  </button>
                ))}
              </div>

              {/* Tab content */}
              <div className="flex-1 flex min-h-0">
                {/* ── BUILDER TAB ── */}
                {editorTab === "builder" && <div
                  ref={canvasRef}
                  onClick={(e) => {
                    if (e.target === canvasRef.current || (e.target instanceof HTMLElement && e.target.closest("[data-canvas-bg]"))) {
                      setSelectedNode(null);
                    }
                  }}
                  className="flex-1 overflow-y-auto bg-[radial-gradient(circle_at_center,rgba(0,0,0,0.03)_1px,transparent_1px)] bg-[length:20px_20px]">
                  <div data-canvas-bg className="max-w-lg mx-auto py-8 px-4">
                    {/* ── Settings cards ─────────────────── */}
                    <div className="grid grid-cols-2 gap-3 mb-6">
                      {/* Trigger */}
                      <div className="bg-white rounded-xl border border-border p-3 shadow-sm">
                        <label className="text-[10px] text-muted uppercase tracking-wider font-semibold">Trigger</label>
                        <div className="flex gap-1.5 mt-1.5">
                          <button onClick={() => setTriggerType("manual")} className={`px-2.5 py-1.5 text-xs rounded-lg border flex-1 transition-colors ${triggerType === "manual" ? "border-green-400 bg-green-50 text-green-700 font-semibold" : "border-border hover:bg-gray-50 text-muted"}`}>
                            Manual
                          </button>
                          <button onClick={() => setTriggerType("tag_added")} className={`px-2.5 py-1.5 text-xs rounded-lg border flex-1 transition-colors ${triggerType === "tag_added" ? "border-green-400 bg-green-50 text-green-700 font-semibold" : "border-border hover:bg-gray-50 text-muted"}`}>
                            Tag added
                          </button>
                        </div>
                        {triggerType === "tag_added" && (
                          <select value={triggerLabelId ?? ""} onChange={(e) => setTriggerLabelId(e.target.value ? Number(e.target.value) : null)}
                            className="mt-1.5 w-full px-2 py-1.5 text-xs border border-border rounded-lg bg-white">
                            <option value="">Select label…</option>
                            {labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                          </select>
                        )}
                      </div>
                      {/* Senders */}
                      <div className="bg-white rounded-xl border border-border p-3 shadow-sm">
                        <label className="text-[10px] text-muted uppercase tracking-wider font-semibold">Sender Numbers</label>
                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                          {accounts.filter((a) => a.status === "connected").map((a) => (
                            <button key={a.id} onClick={() => setSenderIds((p) => p.includes(a.id) ? p.filter((x) => x !== a.id) : [...p, a.id])}
                              className={`px-2 py-1 text-[11px] rounded-lg border transition-colors ${senderIds.includes(a.id) ? "border-primary bg-primary/10 text-primary font-semibold" : "border-border text-muted hover:bg-gray-50"}`}>
                              {a.label}{a.phone_number ? ` (+${a.phone_number})` : ""}
                            </button>
                          ))}
                          {accounts.filter((a) => a.status === "connected").length === 0 && (
                            <span className="text-[11px] text-muted py-1">No connected numbers</span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* ── Visual workflow ────────────────── */}

                    {/* Trigger node */}
                    <div className="flex flex-col items-center">
                      <div className="bg-white rounded-xl border-2 border-green-300 shadow-md px-5 py-3 flex items-center gap-3 w-full max-w-sm">
                        <div className="w-10 h-10 rounded-xl bg-green-500 flex items-center justify-center shrink-0 shadow-sm">
                          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
                        </div>
                        <div>
                          <div className="text-xs font-bold text-green-700 uppercase tracking-wider">Trigger</div>
                          <div className="text-sm font-medium text-green-800">
                            {triggerType === "tag_added" ? `Tag: ${labels.find((l) => l.id === triggerLabelId)?.name || "—"}` : "Manual start"}
                          </div>
                        </div>
                        <div className="ml-auto">
                          <span className="w-5 h-5 rounded-full bg-green-100 flex items-center justify-center">
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="text-green-600"><polyline points="20 6 9 17 4 12" /></svg>
                          </span>
                        </div>
                      </div>

                      {/* Connector to first node */}
                      <Connector hasAdd onAdd={(type) => {
                        const factory = type === "message" ? newMsg : type === "wait" ? newWait : newDrip;
                        setNodes([factory(), ...nodes]);
                      }} />
                    </div>

                    {/* Nodes */}
                    {nodes.map((node, ni) => {
                      const style = NODE_STYLES[node.type];
                      const isSelected = selectedNode === ni;
                      return (
                        <div key={node.id} className="flex flex-col items-center">
                          {/* Node card */}
                          <div
                            onClick={(e) => { e.stopPropagation(); setSelectedNode(isSelected ? null : ni); }}
                            className={`${style.bg} rounded-xl border-2 ${isSelected ? `${style.border} ring-2 ${style.ring} shadow-lg` : `${style.border} shadow-md`} px-5 py-3.5 w-full max-w-sm cursor-pointer transition-all hover:shadow-lg relative group`}
                          >
                            <div className="flex items-center gap-3">
                              <div className={`w-10 h-10 rounded-xl ${style.accent} flex items-center justify-center shrink-0 shadow-sm text-white`}>
                                <NodeIcon type={node.type} />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className={`text-xs font-bold ${style.text} uppercase tracking-wider`}>
                                  {node.type === "message" ? "Message" : node.type === "wait" ? "Wait" : "Drip Gate"}
                                </div>
                                <div className="text-sm text-gray-700 truncate">
                                  {node.type === "message" ? (
                                    (node.variants?.[0] || "").slice(0, 50) || "Click to edit…"
                                  ) : node.type === "wait" ? (
                                    `${node.amount} ${node.unit}${node.check_reply ? " · skip if replied" : ""}`
                                  ) : (
                                    `${node.batch_size}/batch · every ${node.amount} ${node.unit}`
                                  )}
                                </div>
                              </div>
                              {node.type === "message" && (node.variants || []).length > 1 && (
                                <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full font-bold">{(node.variants || []).length}v</span>
                              )}
                              <span className={`text-xs font-bold ${style.text} opacity-40`}>#{ni + 1}</span>
                            </div>
                            {/* Quick actions on hover */}
                            <div className="absolute -right-2 top-1/2 -translate-y-1/2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button onClick={(e) => { e.stopPropagation(); moveNode(ni, -1); }} disabled={ni === 0} className="w-6 h-6 rounded-full bg-white border border-border shadow-sm flex items-center justify-center text-muted hover:text-foreground disabled:opacity-20">
                                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 15l-6-6-6 6" /></svg>
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); removeNode(ni); }} className="w-6 h-6 rounded-full bg-white border border-red-200 shadow-sm flex items-center justify-center text-red-400 hover:text-red-600 hover:border-red-400">
                                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); moveNode(ni, 1); }} disabled={ni === nodes.length - 1} className="w-6 h-6 rounded-full bg-white border border-border shadow-sm flex items-center justify-center text-muted hover:text-foreground disabled:opacity-20">
                                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M6 9l6 6 6-6" /></svg>
                              </button>
                            </div>
                          </div>

                          {/* Connector */}
                          {ni < nodes.length - 1 ? (
                            <Connector hasAdd onAdd={(type) => insertNodeAfter(ni, type)} />
                          ) : (
                            <Connector hasAdd onAdd={(type) => insertNodeAfter(ni, type)} />
                          )}
                        </div>
                      );
                    })}

                    {/* End node */}
                    <div className="flex flex-col items-center">
                      <div className="bg-white rounded-xl border-2 border-dashed border-gray-300 px-5 py-3 flex items-center gap-3 w-full max-w-sm">
                        <div className="w-10 h-10 rounded-xl bg-gray-200 flex items-center justify-center shrink-0">
                          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-gray-500"><path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
                        </div>
                        <div>
                          <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">End</div>
                          <div className="text-sm text-gray-400">Sequence complete</div>
                        </div>
                      </div>
                    </div>

                    {nodes.length === 0 && (
                      <div className="text-center py-4">
                        <p className="text-sm text-muted mb-3">Add your first step</p>
                        <div className="flex items-center justify-center gap-2">
                          <button onClick={() => setNodes([newMsg()])} className="px-3 py-2 text-xs rounded-lg border-2 border-dashed border-blue-300 text-blue-500 hover:bg-blue-50 font-medium transition-colors">+ Message</button>
                          <button onClick={() => setNodes([newWait()])} className="px-3 py-2 text-xs rounded-lg border-2 border-dashed border-amber-300 text-amber-500 hover:bg-amber-50 font-medium transition-colors">+ Wait</button>
                          <button onClick={() => setNodes([newDrip()])} className="px-3 py-2 text-xs rounded-lg border-2 border-dashed border-purple-300 text-purple-500 hover:bg-purple-50 font-medium transition-colors">+ Drip</button>
                        </div>
                      </div>
                    )}

                    {/* Safety note */}
                    <div className="mt-6 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-800">
                      <strong>Safety limits:</strong> Max 200 msg/day per sender. Random 10-30s delay. No auto-retry on failure.
                    </div>
                  </div>
                </div>}

                {/* Right panel — node config (builder tab only) */}
                {editorTab === "builder" && selectedNode !== null && nodes[selectedNode] && (
                  <div ref={configPanelRef} className="w-96 border-l border-border bg-white overflow-y-auto shrink-0 hidden md:block">
                    <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                      <h3 className="font-semibold text-sm">
                        {nodes[selectedNode].type === "message" ? "📨 Message" : nodes[selectedNode].type === "wait" ? "⏳ Wait" : "🚿 Drip Gate"} — Step {selectedNode + 1}
                      </h3>
                      <button onClick={() => setSelectedNode(null)} className="p-1 rounded hover:bg-gray-100 text-muted">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                      </button>
                    </div>
                    <div className="p-4 space-y-4">
                      {nodes[selectedNode].type === "message" && (() => {
                        const ni = selectedNode;
                        const node = nodes[ni];
                        return (
                          <>
                            {(node.variants || [""]).map((v, vi) => (
                              <div key={vi}>
                                <div className="flex items-center justify-between mb-1">
                                  <label className="text-xs text-muted font-medium">
                                    {(node.variants || []).length > 1 ? `Variant ${vi + 1}` : "Message text"}
                                  </label>
                                  {(node.variants || []).length > 1 && (
                                    <button onClick={() => removeVariant(ni, vi)} className="text-xs text-red-400 hover:text-red-600">Remove</button>
                                  )}
                                </div>
                                <textarea
                                  ref={(el) => { taRefs.current[`${ni}-${vi}`] = el; }}
                                  value={v}
                                  onChange={(e) => updateVariant(ni, vi, e.target.value)}
                                  rows={4}
                                  placeholder="Type your message…"
                                  className="w-full px-3 py-2 text-sm border border-border rounded-lg resize-y bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors"
                                />
                                <VariablePills fields={contactFields} onInsert={(varName) => insertVariable(ni, vi, varName)} />
                              </div>
                            ))}
                            <button onClick={() => addVariant(ni)} className="text-xs text-blue-600 hover:underline font-medium">
                              + Add variant (rotates round-robin)
                            </button>
                          </>
                        );
                      })()}

                      {nodes[selectedNode].type === "wait" && (() => {
                        const ni = selectedNode;
                        const node = nodes[ni];
                        return (
                          <div className="space-y-3">
                            <div>
                              <label className="text-xs text-muted font-medium mb-1 block">Duration</label>
                              <div className="flex gap-2">
                                <input type="number" min={1} value={node.amount ?? 1} onChange={(e) => updateNode(ni, { amount: Math.max(1, Number(e.target.value)) })}
                                  className="w-24 px-3 py-2 text-sm border border-border rounded-lg bg-white" />
                                <select value={node.unit ?? "hours"} onChange={(e) => updateNode(ni, { unit: e.target.value as "minutes" | "hours" | "days" })}
                                  className="px-3 py-2 text-sm border border-border rounded-lg bg-white flex-1">
                                  <option value="minutes">minutes</option>
                                  <option value="hours">hours</option>
                                  <option value="days">days</option>
                                </select>
                              </div>
                            </div>
                            <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
                              <input type="checkbox" checked={!!node.check_reply} onChange={(e) => updateNode(ni, { check_reply: e.target.checked })} className="rounded" />
                              Skip next step if contact replied
                            </label>
                          </div>
                        );
                      })()}

                      {nodes[selectedNode].type === "drip" && (() => {
                        const ni = selectedNode;
                        const node = nodes[ni];
                        return (
                          <div className="space-y-3">
                            <div>
                              <label className="text-xs text-muted font-medium mb-1 block">Batch size</label>
                              <input type="number" min={1} max={200} value={node.batch_size ?? 50}
                                onChange={(e) => updateNode(ni, { batch_size: Math.max(1, Math.min(200, Number(e.target.value))) })}
                                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white" />
                              <p className="text-[11px] text-muted mt-1">Contacts released per sender number per interval</p>
                            </div>
                            <div>
                              <label className="text-xs text-muted font-medium mb-1 block">Interval</label>
                              <div className="flex gap-2">
                                <input type="number" min={1} value={node.amount ?? 1} onChange={(e) => updateNode(ni, { amount: Math.max(1, Number(e.target.value)) })}
                                  className="w-24 px-3 py-2 text-sm border border-border rounded-lg bg-white" />
                                <select value={node.unit ?? "hours"} onChange={(e) => updateNode(ni, { unit: e.target.value as "minutes" | "hours" | "days" })}
                                  className="px-3 py-2 text-sm border border-border rounded-lg bg-white flex-1">
                                  <option value="minutes">minutes</option>
                                  <option value="hours">hours</option>
                                  <option value="days">days</option>
                                </select>
                              </div>
                            </div>
                            <p className="text-xs text-muted bg-amber-50 px-3 py-2 rounded-lg">Rate-limits how many contacts proceed past this point. Max 200/day per number.</p>
                          </div>
                        );
                      })()}

                      <div className="pt-3 border-t border-border">
                        <button onClick={() => removeNode(selectedNode)} className="text-xs text-red-500 hover:text-red-700 font-medium flex items-center gap-1">
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
                          Delete this step
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* ── ENROLL TAB ── */}
                {editorTab === "enroll" && (
                  <div className="flex-1 overflow-y-auto p-6">
                    <div className="max-w-2xl mx-auto">
                      {!editId ? (
                        <div className="text-center py-12 text-muted">
                          <p className="text-sm">Save the campaign first to enroll contacts.</p>
                        </div>
                      ) : (
                        <>
                          <h3 className="font-semibold text-sm mb-3">Select contacts to enroll</h3>

                          {enrollResult && (
                            <div className="mb-4 px-4 py-3 rounded-lg bg-green-50 border border-green-200 text-sm text-green-800">
                              Enrolled <strong>{enrollResult.enrolled}</strong> contact{enrollResult.enrolled !== 1 ? "s" : ""}.
                              {enrollResult.skipped > 0 && <span> Skipped {enrollResult.skipped} (already enrolled).</span>}
                            </div>
                          )}

                          {/* Batch selector */}
                          <div className="mb-4">
                            <label className="text-xs text-muted font-medium mb-1 block">Tag / Batch</label>
                            <select
                              value={enrollBatchId ?? ""}
                              onChange={(e) => {
                                const id = e.target.value ? Number(e.target.value) : null;
                                setEnrollBatchId(id);
                                setEnrollSelected(new Set());
                                setEnrollContacts([]);
                                setEnrollResult(null);
                                if (id) loadEnrollContacts(id);
                              }}
                              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white"
                            >
                              <option value="">-- Select a tag --</option>
                              {batches.map((b) => (
                                <option key={b.id} value={b.id}>{b.tag} ({b.total} contacts)</option>
                              ))}
                            </select>
                          </div>

                          {/* Contact list */}
                          {enrollBatchId && (
                            <>
                              {enrollLoading && enrollContacts.length === 0 ? (
                                <p className="text-sm text-muted animate-pulse py-4">Loading contacts…</p>
                              ) : enrollContacts.length === 0 ? (
                                <p className="text-sm text-muted py-4">No contacts in this batch.</p>
                              ) : (
                                <>
                                  <div className="flex items-center justify-between mb-2">
                                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={enrollSelected.size === enrollContacts.length}
                                        onChange={(e) => {
                                          if (e.target.checked) setEnrollSelected(new Set(enrollContacts.map((c) => c.id)));
                                          else setEnrollSelected(new Set());
                                        }}
                                        className="rounded"
                                      />
                                      <span className="font-medium">Select all ({enrollContacts.length})</span>
                                    </label>
                                    <span className="text-xs text-muted">{enrollSelected.size} selected</span>
                                  </div>

                                  <div className="border border-border rounded-lg overflow-hidden mb-4 max-h-[400px] overflow-y-auto">
                                    {enrollContacts.map((c) => (
                                      <label key={c.id} className="flex items-center gap-3 px-3 py-2 border-b border-border/50 last:border-0 hover:bg-gray-50 cursor-pointer">
                                        <input
                                          type="checkbox"
                                          checked={enrollSelected.has(c.id)}
                                          onChange={(e) => {
                                            const next = new Set(enrollSelected);
                                            if (e.target.checked) next.add(c.id); else next.delete(c.id);
                                            setEnrollSelected(next);
                                          }}
                                          className="rounded"
                                        />
                                        <div className="flex-1 min-w-0">
                                          <span className="text-sm font-medium">
                                            {c.first_name || c.last_name ? `${c.first_name || ""} ${c.last_name || ""}`.trim() : c.name || "—"}
                                          </span>
                                          <span className="text-xs text-muted ml-2">{c.phone}</span>
                                        </div>
                                        {c.wa_status === "yes" && <span className="text-[10px] text-green-600 bg-green-50 px-1.5 py-0.5 rounded">WA</span>}
                                        {c.wa_status === "no" && <span className="text-[10px] text-red-500 bg-red-50 px-1.5 py-0.5 rounded">No WA</span>}
                                      </label>
                                    ))}
                                  </div>

                                  <button
                                    onClick={doEnroll}
                                    disabled={enrollLoading || enrollSelected.size === 0}
                                    className="px-5 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-dark disabled:opacity-50 transition-colors"
                                  >
                                    {enrollLoading ? "Enrolling…" : `Enroll ${enrollSelected.size} contact${enrollSelected.size !== 1 ? "s" : ""}`}
                                  </button>
                                </>
                              )}
                            </>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}

                {/* ── LOGS TAB ── */}
                {editorTab === "logs" && (
                  <div className="flex-1 overflow-y-auto p-6">
                    <div className="max-w-3xl mx-auto">
                      {!editId ? (
                        <div className="text-center py-12 text-muted">
                          <p className="text-sm">Save the campaign first to see logs.</p>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center justify-between mb-4">
                            <h3 className="font-semibold text-sm">Campaign Runs ({runsTotal})</h3>
                            <div className="flex gap-2">
                              <select
                                value={logsFilter}
                                onChange={(e) => {
                                  setLogsFilter(e.target.value);
                                  if (editId) {
                                    setRunsLoading(true);
                                    api.listCampaignRuns(editId, { status: e.target.value || undefined, limit: 200 })
                                      .then((r) => { setRuns(r.runs); setRunsTotal(r.total); })
                                      .catch(() => {})
                                      .finally(() => setRunsLoading(false));
                                  }
                                }}
                                className="px-2 py-1 text-xs border border-border rounded-lg bg-white"
                              >
                                <option value="">All statuses</option>
                                <option value="active">Active</option>
                                <option value="waiting">Waiting</option>
                                <option value="completed">Completed</option>
                                <option value="failed">Failed</option>
                                <option value="stopped">Stopped</option>
                              </select>
                              <button
                                onClick={() => editId && loadRuns(editId)}
                                className="px-2 py-1 text-xs border border-border rounded-lg hover:bg-gray-50"
                              >
                                Refresh
                              </button>
                            </div>
                          </div>

                          {/* Summary pills */}
                          {runs.length > 0 && (
                            <div className="flex gap-2 mb-4 flex-wrap">
                              {(() => {
                                const counts: Record<string, number> = {};
                                runs.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
                                const colors: Record<string, string> = {
                                  active: "bg-blue-50 text-blue-700",
                                  waiting: "bg-amber-50 text-amber-700",
                                  queued: "bg-indigo-50 text-indigo-700",
                                  completed: "bg-green-50 text-green-700",
                                  failed: "bg-red-50 text-red-700",
                                  stopped: "bg-gray-100 text-gray-600",
                                  replied: "bg-teal-50 text-teal-700",
                                };
                                return Object.entries(counts).map(([s, c]) => (
                                  <span key={s} className={`px-2.5 py-1 text-xs font-medium rounded-full ${colors[s] || "bg-gray-100 text-gray-600"}`}>
                                    {c} {s}
                                  </span>
                                ));
                              })()}
                            </div>
                          )}

                          {runsLoading ? (
                            <p className="text-sm text-muted animate-pulse py-4">Loading…</p>
                          ) : runs.length === 0 ? (
                            <div className="text-center py-12 text-muted">
                              <p className="text-sm">No runs yet. Enroll contacts and start the campaign.</p>
                            </div>
                          ) : (
                            <div className="border border-border rounded-lg overflow-hidden">
                              {runs.map((r) => {
                                const statusColor: Record<string, string> = {
                                  active: "text-blue-700 bg-blue-50",
                                  waiting: "text-amber-700 bg-amber-50",
                                  queued: "text-indigo-700 bg-indigo-50",
                                  completed: "text-green-700 bg-green-50",
                                  failed: "text-red-600 bg-red-50",
                                  stopped: "text-gray-600 bg-gray-100",
                                  replied: "text-teal-700 bg-teal-50",
                                };
                                const isExpanded = expandedRun === r.id;
                                return (
                                  <div key={r.id} className="border-b border-border/50 last:border-0">
                                    <div
                                      onClick={() => {
                                        if (isExpanded) { setExpandedRun(null); }
                                        else {
                                          setExpandedRun(r.id);
                                          if (!runEvents[r.id] && editId) loadRunEvents(editId, r.id);
                                        }
                                      }}
                                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 cursor-pointer"
                                    >
                                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={`text-muted transition-transform ${isExpanded ? "rotate-90" : ""}`}>
                                        <path d="M9 18l6-6-6-6" />
                                      </svg>
                                      <div className="flex-1 min-w-0">
                                        <span className="text-sm font-medium">{r.contact_name || r.phone}</span>
                                        {r.contact_name && <span className="text-xs text-muted ml-2">{r.phone}</span>}
                                      </div>
                                      <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${statusColor[r.status] || "bg-gray-100 text-gray-600"}`}>
                                        {r.status}
                                      </span>
                                      {r.node_id && <span className="text-[10px] text-muted">@ {r.node_id}</span>}
                                      <span className="text-[10px] text-muted">{r.enrolled_at ? new Date(r.enrolled_at).toLocaleString() : ""}</span>
                                    </div>

                                    {/* Expanded events */}
                                    {isExpanded && (
                                      <div className="bg-gray-50 border-t border-border/50 px-6 py-3">
                                        {!runEvents[r.id] ? (
                                          <p className="text-xs text-muted animate-pulse">Loading events…</p>
                                        ) : runEvents[r.id].length === 0 ? (
                                          <p className="text-xs text-muted">No events recorded yet.</p>
                                        ) : (
                                          <div className="space-y-1">
                                            {runEvents[r.id].map((ev) => {
                                              const kindIcons: Record<string, string> = {
                                                sent: "text-green-600",
                                                failed: "text-red-600",
                                                completed: "text-green-700",
                                                waited: "text-amber-600",
                                                released: "text-purple-600",
                                                replied: "text-teal-600",
                                              };
                                              return (
                                                <div key={ev.id} className="flex items-start gap-2 text-xs">
                                                  <span className="text-muted whitespace-nowrap">
                                                    {ev.at ? new Date(ev.at).toLocaleTimeString() : "—"}
                                                  </span>
                                                  <span className={`font-medium uppercase ${kindIcons[ev.kind] || "text-gray-500"}`}>{ev.kind}</span>
                                                  {ev.node_id && <span className="text-muted">node: {ev.node_id}</span>}
                                                  {ev.variant_index != null && <span className="text-muted">v{ev.variant_index + 1}</span>}
                                                  {ev.detail && <span className="text-muted truncate max-w-[200px]" title={ev.detail}>{ev.detail}</span>}
                                                </div>
                                              );
                                            })}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
