"use client";

import { useCallback, useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import * as api from "@/lib/api";

export default function UploadedTab() {
  const batches = useStore((s) => s.batches);
  const contacts = useStore((s) => s.uploadedContacts);
  const total = useStore((s) => s.uploadedTotal);
  const labels = useStore((s) => s.labels);

  const [selectedBatch, setSelectedBatch] = useState<number | undefined>(undefined);
  const [waFilter, setWaFilter] = useState<string>("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const PAGE_SIZE = 50;

  const loadBatches = useCallback(async () => {
    try {
      useStore.getState().setBatches(await api.listBatches());
    } catch {}
  }, []);

  const loadContacts = useCallback(async (batchId?: number, wa?: string, q?: string, offset = 0) => {
    setLoading(true);
    try {
      const r = await api.listUploadedContacts({
        batch_id: batchId,
        wa: wa || undefined,
        q: q || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      useStore.getState().setUploadedContacts(r.contacts, r.total);
    } catch {} finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadBatches(); }, [loadBatches]);

  useEffect(() => {
    loadContacts(selectedBatch, waFilter, query, page * PAGE_SIZE);
  }, [selectedBatch, waFilter, query, page, loadContacts]);

  function batchLabel(b: api.ContactBatch) {
    const lb = labels.find((l) => l.id === b.label_id);
    return lb ? lb.color : "#888";
  }

  async function handleDelete(batchId: number) {
    if (!window.confirm("Delete this batch and all its contacts?")) return;
    try {
      await api.deleteBatch(batchId);
      if (selectedBatch === batchId) setSelectedBatch(undefined);
      loadBatches();
    } catch {}
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Batch filter bar */}
      <div className="px-3 py-2 border-b border-border/60 space-y-2">
        <div className="flex gap-2 items-center">
          <select
            value={selectedBatch ?? ""}
            onChange={(e) => { setSelectedBatch(e.target.value ? Number(e.target.value) : undefined); setPage(0); }}
            className="flex-1 min-w-0 px-2 py-1.5 text-sm border border-border rounded-lg bg-white"
          >
            <option value="">All batches</option>
            {batches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.tag} — {b.filename} ({b.total})
              </option>
            ))}
          </select>
          <select
            value={waFilter}
            onChange={(e) => { setWaFilter(e.target.value); setPage(0); }}
            className="px-2 py-1.5 text-sm border border-border rounded-lg bg-white"
          >
            <option value="">All</option>
            <option value="yes">Has WhatsApp</option>
            <option value="no">No WhatsApp</option>
            <option value="unchecked">Unchecked</option>
          </select>
        </div>
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPage(0); }}
          placeholder="Search name or phone…"
          className="w-full px-2 py-1.5 text-sm border border-border rounded-lg"
        />
      </div>

      {/* Batch summary cards */}
      {!selectedBatch && batches.length > 0 && (
        <div className="px-3 py-2 border-b border-border/60 max-h-32 overflow-y-auto">
          <div className="flex flex-wrap gap-2">
            {batches.map((b) => (
              <div key={b.id} className="flex items-center gap-1.5 text-xs bg-gray-50 rounded-lg px-2 py-1 border border-border/60">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: batchLabel(b) }} />
                <span className="font-medium">{b.tag}</span>
                <span className="text-muted">({b.counts?.total ?? b.total})</span>
                {b.counts && b.counts.yes > 0 && <span className="text-green-600">✓{b.counts.yes}</span>}
                <button onClick={() => handleDelete(b.id)} className="text-muted hover:text-red-500 ml-1" title="Delete batch">×</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Contact list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading && contacts.length === 0 ? (
          <p className="p-6 text-center text-muted text-sm animate-pulse">Loading…</p>
        ) : contacts.length === 0 ? (
          <p className="p-6 text-center text-muted text-sm">
            {batches.length === 0 ? "No contacts uploaded yet. Click the upload button above." : "No contacts match the filters."}
          </p>
        ) : (
          contacts.map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-3 py-2 border-b border-border/60 hover:bg-background text-sm">
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium truncate">{c.name || "—"}</span>
                  <span className="text-muted text-xs">+{c.phone}</span>
                </div>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                c.wa_status === "yes" ? "bg-green-100 text-green-700" :
                c.wa_status === "no" ? "bg-red-100 text-red-600" :
                "bg-gray-100 text-gray-500"
              }`}>
                {c.wa_status === "yes" ? "✓ WhatsApp" : c.wa_status === "no" ? "No WA" : "Unchecked"}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-3 py-2 border-t border-border text-xs text-muted">
          <span>{total} contacts</span>
          <div className="flex gap-1">
            <button disabled={page === 0} onClick={() => setPage(page - 1)} className="px-2 py-1 rounded border border-border disabled:opacity-40 hover:bg-gray-50">Prev</button>
            <span className="px-2 py-1">{page + 1} / {totalPages}</span>
            <button disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)} className="px-2 py-1 rounded border border-border disabled:opacity-40 hover:bg-gray-50">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
