"use client";

import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import * as api from "@/lib/api";

interface Props {
  campaign: api.Campaign;
  onClose: () => void;
  recoveredSessionId?: number;
  recoveredStatus?: string;
}

type Phase = "config" | "warmup" | "running" | "completed";

export default function ImmediateStart({ campaign, onClose, recoveredSessionId, recoveredStatus }: Props) {
  const accounts = useStore((s) => s.accounts);
  const immediateSession = useStore((s) => s.immediateSession);

  const [phase, setPhase] = useState<Phase>(
    recoveredSessionId ? (recoveredStatus === "completed" ? "completed" : "running") : "config"
  );
  const [delay, setDelay] = useState(10);
  const [assignments, setAssignments] = useState<
    Array<{ accountId: number; startIdx: number; endIdx: number }>
  >([]);
  const [batches, setBatches] = useState<api.ContactBatch[]>([]);
  const [batchId, setBatchId] = useState<number | null>(null);
  const [contacts, setContacts] = useState<api.UploadedContact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [countdown, setCountdown] = useState(30);
  const [sessionId, setSessionId] = useState<number | null>(recoveredSessionId ?? null);

  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const connectedAccounts = accounts.filter((a) => a.status === "connected");

  // Recovery: if we have a recovered session, initialize the store and start polling
  useEffect(() => {
    if (recoveredSessionId && !immediateSession) {
      useStore.getState().setImmediateSession({
        sessionId: recoveredSessionId,
        campaignId: campaign.id,
        status: recoveredStatus || "running",
        currentNodeIndex: 0,
        nodeResults: [],
        contactEvents: [],
      });
      pollProgress(recoveredSessionId);
      startPolling(recoveredSessionId);
    }
  }, [recoveredSessionId]);

  // Poll progress from server every 3s as fallback to WebSocket
  function startPolling(sid: number) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => pollProgress(sid), 3000);
  }

  async function pollProgress(sid: number) {
    try {
      const resp = await api.immediateProgress(campaign.id, sid);
      const sess = useStore.getState().immediateSession;
      if (!sess) return;

      // Build contact events from server response
      const contactEvents = resp.contacts
        .filter((c) => c.status !== "pending")
        .map((c) => ({
          contactId: c.contact_id,
          phone: c.phone,
          name: c.name,
          status: (c.status === "active" || c.status === "completed" ? "sent" :
                  c.status === "failed" ? "failed" :
                  c.status === "replied" ? "skipped" : "sent") as "sent" | "failed" | "skipped" | "pending",
          nodeIndex: resp.current_node_index,
          accountId: 0,
        }));

      // Build node results from server progress
      const nodeResults = resp.progress?.nodes.map((n: any) => ({
        nodeIndex: n.node_index,
        nodeId: n.node_id,
        type: n.type,
        sent: n.type === "drip" ? (n.sent ?? 0) : n.senders?.reduce((s: number, x: any) => s + (x.sent || 0), 0),
        failed: n.type === "drip" ? (n.failed ?? 0) : n.senders?.reduce((s: number, x: any) => s + (x.failed || 0), 0),
        batchesCompleted: n.batches_completed,
        totalBatches: n.total_batches,
        repliedDuringWait: n.replied_during_wait,
        waitSeconds: n.wait_seconds,
      })) || [];

      useStore.getState().setImmediateSession({
        ...sess,
        status: resp.status,
        currentNodeIndex: resp.current_node_index,
        nodeResults: nodeResults.length > 0 ? nodeResults : sess.nodeResults,
        contactEvents: contactEvents.length > 0 ? contactEvents : sess.contactEvents,
      });

      if (resp.status === "completed" || resp.status === "failed") {
        if (pollRef.current) clearInterval(pollRef.current);
        setPhase("completed");
      }
    } catch {}
  }

  useEffect(() => {
    api.listBatches().then(setBatches).catch(() => {});
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  useEffect(() => {
    if (connectedAccounts.length > 0 && assignments.length === 0) {
      setAssignments([{ accountId: connectedAccounts[0].id, startIdx: 1, endIdx: 50 }]);
    }
  }, [connectedAccounts.length]);

  async function loadContacts(bid: number) {
    setLoading(true);
    try {
      const r = await api.listUploadedContacts({ batch_id: bid, limit: 2000 });
      setContacts(r.contacts);
    } catch {} finally {
      setLoading(false);
    }
  }

  function addSender() {
    if (connectedAccounts.length === 0) return;
    const lastEnd = assignments.length > 0 ? assignments[assignments.length - 1].endIdx : 0;
    setAssignments([...assignments, {
      accountId: connectedAccounts[Math.min(assignments.length, connectedAccounts.length - 1)].id,
      startIdx: lastEnd + 1,
      endIdx: lastEnd + 50,
    }]);
  }

  function removeSender(idx: number) {
    setAssignments(assignments.filter((_, i) => i !== idx));
  }

  function updateAssignment(idx: number, patch: Partial<typeof assignments[0]>) {
    setAssignments(assignments.map((a, i) => i === idx ? { ...a, ...patch } : a));
  }

  async function handleStart() {
    if (!batchId || contacts.length === 0) {
      setError("Select a contact batch first");
      return;
    }
    if (assignments.length === 0) {
      setError("Add at least one sender number");
      return;
    }

    setError("");
    setLoading(true);

    try {
      const senderAssignments: api.SenderAssignment[] = assignments.map((a) => {
        const start = Math.max(0, a.startIdx - 1);
        const end = Math.min(contacts.length, a.endIdx);
        return {
          account_id: a.accountId,
          contact_ids: contacts.slice(start, end).map((c) => c.id),
        };
      });

      const resp = await api.immediateStart(campaign.id, {
        sender_assignments: senderAssignments,
        delay,
      });

      setSessionId(resp.session_id);
      useStore.getState().setImmediateSession({
        sessionId: resp.session_id,
        campaignId: campaign.id,
        status: "warmup",
        currentNodeIndex: 0,
        nodeResults: [],
        contactEvents: [],
      });

      setPhase("warmup");
      setCountdown(30);

      countdownRef.current = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(countdownRef.current!);
            countdownRef.current = null;
            launchCampaign(resp.session_id);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } catch (e) {
      setError(e instanceof api.ApiError ? e.detail : "Failed to start");
    } finally {
      setLoading(false);
    }
  }

  async function launchCampaign(sid: number) {
    try {
      await api.immediateLaunch(campaign.id, sid);
      setPhase("running");
      useStore.getState().setImmediateSession({
        ...useStore.getState().immediateSession!,
        status: "running",
      });
      startPolling(sid);
    } catch (e) {
      setError(e instanceof api.ApiError ? e.detail : "Launch failed");
      setPhase("config");
    }
  }

  async function handlePause() {
    if (!sessionId) return;
    try {
      const resp = await api.immediatePause(campaign.id, sessionId);
      const sess = useStore.getState().immediateSession;
      if (sess) {
        useStore.getState().setImmediateSession({ ...sess, status: resp.status });
      }
    } catch {}
  }

  async function handleStop() {
    if (!sessionId) return;
    try {
      await api.immediateStop(campaign.id, sessionId);
      if (pollRef.current) clearInterval(pollRef.current);
      // Fetch final progress from server
      await pollProgress(sessionId);
      setPhase("completed");
      const sess = useStore.getState().immediateSession;
      if (sess) {
        useStore.getState().setImmediateSession({ ...sess, status: "completed" });
      }
    } catch {}
  }

  // Watch for completed status from WebSocket
  useEffect(() => {
    if (immediateSession?.status === "completed" && phase === "running") {
      if (pollRef.current) clearInterval(pollRef.current);
      if (sessionId) pollProgress(sessionId);
      setPhase("completed");
    }
  }, [immediateSession?.status]);

  function downloadCSV() {
    if (!immediateSession) return;
    const rows = [["Contact", "Phone", "Status", "Step", "Sender"].join(",")];
    for (const evt of immediateSession.contactEvents) {
      const acc = accounts.find((a) => a.id === evt.accountId);
      rows.push([
        `"${evt.name}"`,
        evt.phone,
        evt.status,
        String(evt.nodeIndex + 1),
        acc?.label || String(evt.accountId),
      ].join(","));
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `campaign-${campaign.id}-immediate-report.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const totalContacts = assignments.reduce((s, a) => {
    const start = Math.max(0, a.startIdx - 1);
    const end = Math.min(contacts.length, a.endIdx);
    return s + Math.max(0, end - start);
  }, 0);

  // ── Config Phase ───────────────────────────────

  if (phase === "config") {
    return (
      <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
          <div className="p-5 border-b border-border">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">Immediate Start</h2>
              <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg text-muted">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <p className="text-sm text-muted mt-1">Campaign: {campaign.name}</p>
          </div>

          <div className="p-5 space-y-5">
            {/* Batch selection */}
            <div>
              <label className="text-sm font-medium block mb-1.5">Contact Batch</label>
              <select
                value={batchId ?? ""}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setBatchId(v || null);
                  if (v) loadContacts(v);
                }}
                className="w-full px-3 py-2 border border-border rounded-lg text-sm"
              >
                <option value="">Select batch...</option>
                {batches.map((b) => (
                  <option key={b.id} value={b.id}>{b.tag} ({b.total} contacts)</option>
                ))}
              </select>
              {contacts.length > 0 && (
                <p className="text-xs text-muted mt-1">{contacts.length} contacts loaded</p>
              )}
            </div>

            {/* Delay */}
            <div>
              <label className="text-sm font-medium block mb-1.5">Delay between messages (seconds)</label>
              <input
                type="number"
                min={1}
                value={delay}
                onChange={(e) => setDelay(Math.max(1, Number(e.target.value)))}
                className="w-24 px-3 py-2 border border-border rounded-lg text-sm"
              />
              {delay < 10 && (
                <p className="text-xs text-amber-600 mt-1">Low delay may trigger WhatsApp rate limits</p>
              )}
            </div>

            {/* Sender assignments */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium">Sender Numbers</label>
                <button onClick={addSender} className="text-xs text-primary hover:underline">+ Add sender</button>
              </div>
              <div className="space-y-3">
                {assignments.map((a, i) => (
                  <div key={i} className="flex items-center gap-2 bg-gray-50 p-3 rounded-lg">
                    <select
                      value={a.accountId}
                      onChange={(e) => updateAssignment(i, { accountId: Number(e.target.value) })}
                      className="flex-1 px-2 py-1.5 text-xs border border-border rounded bg-white"
                    >
                      {connectedAccounts.map((ac) => (
                        <option key={ac.id} value={ac.id}>{ac.label} ({ac.phone_number})</option>
                      ))}
                    </select>
                    <div className="flex items-center gap-1 text-xs">
                      <input
                        type="number"
                        min={1}
                        value={a.startIdx}
                        onChange={(e) => updateAssignment(i, { startIdx: Math.max(1, Number(e.target.value)) })}
                        className="w-16 px-2 py-1.5 border border-border rounded bg-white text-center"
                      />
                      <span>-</span>
                      <input
                        type="number"
                        min={a.startIdx}
                        value={a.endIdx}
                        onChange={(e) => updateAssignment(i, { endIdx: Math.max(a.startIdx, Number(e.target.value)) })}
                        className="w-16 px-2 py-1.5 border border-border rounded bg-white text-center"
                      />
                    </div>
                    {assignments.length > 1 && (
                      <button onClick={() => removeSender(i)} className="p-1 text-red-400 hover:text-red-600">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Summary */}
            {contacts.length > 0 && (
              <div className="bg-blue-50 p-3 rounded-lg text-sm">
                <p className="font-medium text-blue-800">Summary</p>
                <p className="text-blue-700 mt-1">
                  {assignments.length} sender{assignments.length > 1 ? "s" : ""} /
                  {" "}{totalContacts} contacts /
                  {" "}{delay}s delay /
                  {" "}{campaign.nodes.length} steps
                </p>
                <p className="text-blue-600 text-xs mt-1">
                  Est. time per step: ~{Math.ceil((totalContacts / Math.max(1, assignments.length)) * delay / 60)} min
                </p>
              </div>
            )}

            {error && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
          </div>

          <div className="p-5 border-t border-border flex justify-end gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-gray-50">Cancel</button>
            <button
              onClick={handleStart}
              disabled={loading || !batchId || contacts.length === 0}
              className="px-5 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium"
            >
              {loading ? "Starting..." : "Start Campaign"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Warmup Phase ───────────────────────────────

  if (phase === "warmup") {
    const pct = ((30 - countdown) / 30) * 100;
    return (
      <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-8 text-center">
          <div className="w-24 h-24 mx-auto mb-6 relative">
            <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
              <circle cx="50" cy="50" r="45" fill="none" stroke="#e5e7eb" strokeWidth="6" />
              <circle
                cx="50" cy="50" r="45" fill="none" stroke="#22c55e" strokeWidth="6"
                strokeDasharray={`${pct * 2.827} ${283 - pct * 2.827}`}
                strokeLinecap="round"
                className="transition-all duration-1000"
              />
            </svg>
            <span className="absolute inset-0 flex items-center justify-center text-3xl font-bold text-green-600">
              {countdown}
            </span>
          </div>
          <h2 className="text-xl font-bold mb-2">Warming Up</h2>
          <p className="text-muted text-sm mb-6">Campaign will start in {countdown} seconds</p>
          {error && <p className="text-sm text-red-600 mb-4">{error}</p>}
          <button
            onClick={() => {
              if (countdownRef.current) clearInterval(countdownRef.current);
              handleStop();
            }}
            className="px-4 py-2 text-sm border border-red-200 text-red-600 rounded-lg hover:bg-red-50"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ── Running Phase ───────────────────────────────

  if (phase === "running") {
    const sess = immediateSession;
    if (!sess) return null;

    const isPaused = sess.status === "paused";
    const sentCount = sess.contactEvents.filter((e) => e.status === "sent").length;
    const failedCount = sess.contactEvents.filter((e) => e.status === "failed").length;
    const skippedCount = sess.contactEvents.filter((e) => e.status === "skipped").length;

    return (
      <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
          <div className="p-5 border-b border-border flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold flex items-center gap-2">
                {isPaused ? "Paused" : "Sending..."}
                {!isPaused && <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />}
              </h2>
              <p className="text-sm text-muted">{campaign.name}</p>
            </div>
            <div className="flex gap-2">
              <button onClick={handlePause} className={`px-3 py-1.5 text-xs rounded-lg border ${isPaused ? "border-green-300 text-green-700 hover:bg-green-50" : "border-amber-300 text-amber-700 hover:bg-amber-50"}`}>
                {isPaused ? "Resume" : "Pause"}
              </button>
              <button onClick={handleStop} className="px-3 py-1.5 text-xs rounded-lg border border-red-200 text-red-600 hover:bg-red-50">
                Stop
              </button>
            </div>
          </div>

          <div className="p-5">
            {/* Stats bar */}
            <div className="flex gap-4 mb-5">
              <div className="flex-1 bg-green-50 rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-green-600">{sentCount}</div>
                <div className="text-xs text-green-700">Sent</div>
              </div>
              <div className="flex-1 bg-red-50 rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-red-600">{failedCount}</div>
                <div className="text-xs text-red-700">Failed</div>
              </div>
              <div className="flex-1 bg-teal-50 rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-teal-600">{skippedCount}</div>
                <div className="text-xs text-teal-700">Replied/Skipped</div>
              </div>
            </div>

            {/* Step progress */}
            <div className="space-y-2 mb-5">
              {campaign.nodes.map((node, ni) => {
                const result = sess.nodeResults.find((r) => r.nodeIndex === ni);
                const isCurrent = sess.currentNodeIndex === ni;
                const isComplete = !!result && (result.type === "message" || result.type === "drip");
                const isWaiting = result?.type === "wait" && result.elapsed !== undefined && result.elapsed < (result.waitSeconds ?? 0);

                return (
                  <div key={node.id} className={`flex items-center gap-3 p-3 rounded-lg border ${isCurrent ? "border-blue-300 bg-blue-50" : isComplete ? "border-green-200 bg-green-50/50" : "border-border"}`}>
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${isComplete ? "bg-green-500 text-white" : isCurrent ? "bg-blue-500 text-white" : "bg-gray-200 text-gray-500"}`}>
                      {isComplete ? (
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                      ) : ni + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium capitalize">{node.type === "drip" ? `Drip (${node.batch_size ?? 5}/${node.amount ?? 1} ${node.unit ?? "min"})` : node.type} {node.type === "wait" ? `(${node.amount} ${node.unit})` : ""}</div>
                      {result && (node.type === "message" || node.type === "drip") && (
                        <div className="text-xs text-muted">{result.sent ?? 0} sent / {result.failed ?? 0} failed{result.type === "drip" && (result as any).batchesCompleted ? ` · ${(result as any).batchesCompleted}/${(result as any).totalBatches} batches` : ""}</div>
                      )}
                      {isWaiting && (
                        <div className="text-xs text-amber-600">
                          Waiting... {Math.floor((result!.elapsed ?? 0) / 60)}m / {Math.floor((result!.waitSeconds ?? 0) / 60)}m
                        </div>
                      )}
                    </div>
                    {isCurrent && !isComplete && <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />}
                  </div>
                );
              })}
            </div>

            {/* Live contact feed */}
            <div className="border border-border rounded-lg max-h-48 overflow-y-auto">
              <div className="p-2 bg-gray-50 border-b border-border text-xs font-medium text-muted sticky top-0">
                Recent activity ({sess.contactEvents.length} total)
              </div>
              {sess.contactEvents.slice(-20).reverse().map((evt, i) => (
                <div key={`${evt.contactId}-${evt.nodeIndex}-${i}`} className="px-3 py-1.5 text-xs flex items-center gap-2 border-b border-border/50 last:border-0">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${evt.status === "sent" ? "bg-green-500" : evt.status === "failed" ? "bg-red-500" : "bg-teal-500"}`} />
                  <span className="font-medium truncate flex-1">{evt.name}</span>
                  <span className="text-muted">{evt.phone}</span>
                  <span className={`font-medium ${evt.status === "sent" ? "text-green-600" : evt.status === "failed" ? "text-red-600" : "text-teal-600"}`}>
                    {evt.status}
                  </span>
                </div>
              ))}
              {sess.contactEvents.length === 0 && (
                <div className="p-4 text-center text-xs text-muted">Waiting for first message...</div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Completed Phase ───────────────────────────────

  if (phase === "completed") {
    const sess = immediateSession;
    if (!sess) return null;

    const sentCount = sess.contactEvents.filter((e) => e.status === "sent").length;
    const failedCount = sess.contactEvents.filter((e) => e.status === "failed").length;
    const skippedCount = sess.contactEvents.filter((e) => e.status === "skipped").length;

    return (
      <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
          <div className="p-5 border-b border-border">
            <h2 className="text-lg font-bold">Campaign Complete</h2>
            <p className="text-sm text-muted">{campaign.name}</p>
          </div>

          <div className="p-5">
            {/* Overall stats */}
            <div className="flex gap-4 mb-6">
              <div className="flex-1 bg-green-50 rounded-xl p-4 text-center">
                <div className="text-3xl font-bold text-green-600">{sentCount}</div>
                <div className="text-sm text-green-700">Sent</div>
              </div>
              <div className="flex-1 bg-red-50 rounded-xl p-4 text-center">
                <div className="text-3xl font-bold text-red-600">{failedCount}</div>
                <div className="text-sm text-red-700">Failed</div>
              </div>
              <div className="flex-1 bg-teal-50 rounded-xl p-4 text-center">
                <div className="text-3xl font-bold text-teal-600">{skippedCount}</div>
                <div className="text-sm text-teal-700">Replied</div>
              </div>
            </div>

            {/* Per-step breakdown */}
            <h3 className="font-semibold text-sm mb-3">Step Breakdown</h3>
            <div className="space-y-2 mb-6">
              {sess.nodeResults.map((nr, i) => (
                <div key={i} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                  <div className="w-7 h-7 rounded-full bg-green-500 text-white flex items-center justify-center text-xs font-bold">
                    {nr.nodeIndex + 1}
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-medium capitalize">{nr.type}</div>
                    {(nr.type === "message" || nr.type === "drip") && (
                      <div className="text-xs text-muted">{nr.sent ?? 0} sent / {nr.failed ?? 0} failed{nr.type === "drip" && (nr as any).batchesCompleted ? ` · ${(nr as any).batchesCompleted}/${(nr as any).totalBatches} batches` : ""}</div>
                    )}
                    {nr.type === "wait" && nr.repliedDuringWait !== undefined && (
                      <div className="text-xs text-muted">{nr.repliedDuringWait} replied during wait</div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Contact list */}
            <h3 className="font-semibold text-sm mb-3">Contact Details</h3>
            <div className="border border-border rounded-lg max-h-60 overflow-y-auto mb-4">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="text-left p-2 font-medium">Contact</th>
                    <th className="text-left p-2 font-medium">Phone</th>
                    <th className="text-left p-2 font-medium">Status</th>
                    <th className="text-left p-2 font-medium">Step</th>
                  </tr>
                </thead>
                <tbody>
                  {sess.contactEvents.map((evt, i) => (
                    <tr key={i} className="border-t border-border/50">
                      <td className="p-2 truncate max-w-[120px]">{evt.name}</td>
                      <td className="p-2">{evt.phone}</td>
                      <td className="p-2">
                        <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${evt.status === "sent" ? "bg-green-100 text-green-700" : evt.status === "failed" ? "bg-red-100 text-red-700" : "bg-teal-100 text-teal-700"}`}>
                          {evt.status}
                        </span>
                      </td>
                      <td className="p-2">{evt.nodeIndex + 1}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="p-5 border-t border-border flex justify-between">
            <button onClick={downloadCSV} className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-gray-50 flex items-center gap-2">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
              Download CSV
            </button>
            <button
              onClick={() => {
                useStore.getState().setImmediateSession(null);
                onClose();
              }}
              className="px-5 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary-dark font-medium"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
