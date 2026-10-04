"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import * as api from "@/lib/api";
import UploadContactsDialog from "@/components/UploadContactsDialog";

export default function ContactsPage() {
  const batches = useStore((s) => s.batches);
  const contacts = useStore((s) => s.uploadedContacts);
  const total = useStore((s) => s.uploadedTotal);
  const labels = useStore((s) => s.labels);
  const accounts = useStore((s) => s.accounts);

  const [selectedBatch, setSelectedBatch] = useState<number | undefined>(undefined);
  const [waFilter, setWaFilter] = useState<string>("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<{ checked: number; yes: number; no: number } | null>(null);
  const PAGE_SIZE = 50;

  const connectedAccounts = accounts.filter((a) => a.status === "connected");

  const loadBatches = useCallback(async () => {
    try {
      useStore.getState().setBatches(await api.listBatches());
    } catch {}
  }, []);

  const loadLabels = useCallback(async () => {
    try {
      useStore.getState().setLabels(await api.listLabels());
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

  useEffect(() => { loadBatches(); loadLabels(); }, [loadBatches, loadLabels]);

  useEffect(() => {
    loadContacts(selectedBatch, waFilter, query, page * PAGE_SIZE);
  }, [selectedBatch, waFilter, query, page, loadContacts]);

  function batchColor(b: api.ContactBatch) {
    const lb = labels.find((l) => l.id === b.label_id);
    return lb ? lb.color : "#888";
  }

  async function handleDeleteBatch(batchId: number) {
    if (!window.confirm("Delete this batch and all its contacts?")) return;
    try {
      await api.deleteBatch(batchId);
      if (selectedBatch === batchId) setSelectedBatch(undefined);
      loadBatches();
    } catch {}
  }

  async function handleCheckWhatsApp() {
    if (connectedAccounts.length === 0) {
      alert("No connected WhatsApp accounts. Connect one first.");
      return;
    }
    setChecking(true);
    setCheckResult(null);
    try {
      const r = await api.checkWhatsApp({
        batch_id: selectedBatch ?? undefined,
        account_id: connectedAccounts[0].id,
      });
      setCheckResult(r);
      // Reload contacts and batches to reflect updated wa_status
      loadContacts(selectedBatch, waFilter, query, page * PAGE_SIZE);
      loadBatches();
    } catch (e) {
      alert(e instanceof api.ApiError ? e.detail : "WhatsApp check failed");
    } finally {
      setChecking(false);
    }
  }

  async function handleRecheckAll() {
    if (connectedAccounts.length === 0) {
      alert("No connected WhatsApp accounts. Connect one first.");
      return;
    }
    // Re-check all contacts (including previously checked ones)
    const ids = contacts.map((c) => c.id);
    if (ids.length === 0) return;
    setChecking(true);
    setCheckResult(null);
    try {
      const r = await api.checkWhatsApp({
        contact_ids: ids,
        account_id: connectedAccounts[0].id,
      });
      setCheckResult(r);
      loadContacts(selectedBatch, waFilter, query, page * PAGE_SIZE);
      loadBatches();
    } catch (e) {
      alert(e instanceof api.ApiError ? e.detail : "WhatsApp re-check failed");
    } finally {
      setChecking(false);
    }
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const selectedBatchObj = batches.find((b) => b.id === selectedBatch);
  const uncheckedCount = selectedBatchObj?.counts?.unchecked ?? batches.reduce((s, b) => s + (b.counts?.unchecked ?? 0), 0);

  return (
    <div className="h-dvh flex flex-col bg-gray-50/30">
      {/* Header */}
      <header className="bg-header-bg text-header-text px-4 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm px-3 py-1.5 rounded-full bg-white/15 hover:bg-white/25 transition-colors">
            ← Chats
          </Link>
          <h1 className="text-lg font-semibold">Contacts</h1>
        </div>
        <div className="flex items-center gap-2">
          {uncheckedCount > 0 && connectedAccounts.length > 0 && (
            <button
              onClick={handleCheckWhatsApp}
              disabled={checking}
              className="px-4 py-2 bg-green-500/90 hover:bg-green-500 text-white rounded-lg text-sm font-medium flex items-center gap-2 disabled:opacity-50 transition-colors"
            >
              {checking ? (
                <>
                  <svg className="animate-spin" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" /></svg>
                  Checking…
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                  Check WhatsApp ({uncheckedCount})
                </>
              )}
            </button>
          )}
          <button
            onClick={() => setShowUpload(true)}
            className="px-4 py-2 bg-white/20 hover:bg-white/30 text-white rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" />
            </svg>
            Upload
          </button>
        </div>
      </header>

      {/* Check result toast */}
      {checkResult && (
        <div className="mx-4 mt-2 px-4 py-2.5 rounded-lg bg-green-50 border border-green-200 text-sm flex items-center justify-between">
          <span className="text-green-800">
            Checked <strong>{checkResult.checked}</strong> contacts —
            <span className="text-green-700 font-medium"> {checkResult.yes} have WhatsApp</span>,
            <span className="text-red-600 font-medium"> {checkResult.no} don&apos;t</span>
          </span>
          <button onClick={() => setCheckResult(null)} className="text-green-600 hover:text-green-800 p-1">✕</button>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {/* Left sidebar: batches */}
        <aside className="w-72 border-r border-border bg-white flex flex-col min-h-0 shrink-0 hidden md:flex">
          <div className="px-3 py-3 border-b border-border/60">
            <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">Upload Batches</h2>
          </div>
          <div className="flex-1 overflow-y-auto">
            <button
              onClick={() => { setSelectedBatch(undefined); setPage(0); }}
              className={`w-full text-left px-3 py-2.5 text-sm border-b border-border/60 hover:bg-gray-50 transition-colors ${selectedBatch === undefined ? "bg-primary/5 font-medium border-l-2 border-l-primary" : ""}`}
            >
              All contacts
              <span className="text-xs text-muted ml-1">({batches.reduce((s, b) => s + b.total, 0)})</span>
            </button>
            {batches.map((b) => (
              <div
                key={b.id}
                className={`group flex items-center justify-between px-3 py-2.5 text-sm border-b border-border/60 hover:bg-gray-50 cursor-pointer transition-colors ${selectedBatch === b.id ? "bg-primary/5 border-l-2 border-l-primary" : ""}`}
                onClick={() => { setSelectedBatch(b.id); setPage(0); }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: batchColor(b) }} />
                  <div className="min-w-0">
                    <div className="truncate font-medium">{b.tag}</div>
                    <div className="text-xs text-muted truncate">{b.filename}</div>
                    {b.counts && (
                      <div className="flex gap-1.5 mt-0.5">
                        <span className="text-[10px] text-muted">{b.counts.total} total</span>
                        {b.counts.yes > 0 && <span className="text-[10px] text-green-600">✓{b.counts.yes}</span>}
                        {b.counts.no > 0 && <span className="text-[10px] text-red-500">✗{b.counts.no}</span>}
                        {b.counts.unchecked > 0 && <span className="text-[10px] text-gray-400">?{b.counts.unchecked}</span>}
                      </div>
                    )}
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDeleteBatch(b.id); }}
                  className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-50 hover:text-red-500 text-muted transition-all"
                  title="Delete batch"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
                </button>
              </div>
            ))}
            {batches.length === 0 && (
              <p className="p-4 text-center text-xs text-muted">No uploads yet.</p>
            )}
          </div>
        </aside>

        {/* Main: contact list */}
        <main className="flex-1 flex flex-col min-h-0 min-w-0">
          {/* Filters bar */}
          <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-3 bg-white shrink-0">
            <div className="relative flex-1 min-w-[200px]">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></svg>
              <input
                value={query}
                onChange={(e) => { setQuery(e.target.value); setPage(0); }}
                placeholder="Search name, email, or phone…"
                className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            {/* Mobile batch selector */}
            <select
              value={selectedBatch ?? ""}
              onChange={(e) => { setSelectedBatch(e.target.value ? Number(e.target.value) : undefined); setPage(0); }}
              className="md:hidden px-3 py-2 text-sm border border-border rounded-lg bg-white"
            >
              <option value="">All batches</option>
              {batches.map((b) => (
                <option key={b.id} value={b.id}>{b.tag} ({b.total})</option>
              ))}
            </select>
            <select
              value={waFilter}
              onChange={(e) => { setWaFilter(e.target.value); setPage(0); }}
              className="px-3 py-2 text-sm border border-border rounded-lg bg-white min-w-[140px]"
            >
              <option value="">All statuses</option>
              <option value="yes">✓ Has WhatsApp</option>
              <option value="no">✗ No WhatsApp</option>
              <option value="unchecked">? Unchecked</option>
            </select>
            {contacts.length > 0 && (
              <button
                onClick={handleRecheckAll}
                disabled={checking}
                className="px-3 py-2 text-xs rounded-lg border border-border hover:bg-gray-50 text-muted hover:text-foreground disabled:opacity-50 flex items-center gap-1.5 transition-colors"
                title="Re-check all visible contacts"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" /></svg>
                Re-check
              </button>
            )}
            <span className="text-sm text-muted whitespace-nowrap">{total} contact{total !== 1 ? "s" : ""}</span>
          </div>

          {/* Contact list */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {loading && contacts.length === 0 ? (
              <div className="p-8 text-center">
                <div className="inline-block w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin mb-3" />
                <p className="text-muted text-sm">Loading contacts…</p>
              </div>
            ) : contacts.length === 0 ? (
              <div className="p-8 text-center">
                <div className="mx-auto w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mb-3">
                  <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted/50"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" /></svg>
                </div>
                <p className="text-muted text-sm mb-3">
                  {batches.length === 0 ? "No contacts uploaded yet." : "No contacts match the filters."}
                </p>
                {batches.length === 0 && (
                  <button
                    onClick={() => setShowUpload(true)}
                    className="px-4 py-2 bg-primary text-white rounded-lg text-sm hover:bg-primary-dark font-medium"
                  >
                    Upload your first contacts
                  </button>
                )}
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50/80 sticky top-0 z-10">
                  <tr>
                    <th className="text-left px-4 py-2.5 font-semibold text-muted text-xs uppercase tracking-wider">First Name</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-muted text-xs uppercase tracking-wider">Last Name</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-muted text-xs uppercase tracking-wider hidden lg:table-cell">Email</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-muted text-xs uppercase tracking-wider">Phone</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-muted text-xs uppercase tracking-wider hidden md:table-cell">Tag</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-muted text-xs uppercase tracking-wider w-32">WhatsApp</th>
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((c) => {
                    const batch = batches.find((b) => b.id === c.batch_id);
                    const displayName = c.first_name || c.last_name
                      ? [c.first_name, c.last_name].filter(Boolean).join(" ")
                      : c.name;
                    return (
                      <tr key={c.id} className="border-b border-border/40 hover:bg-blue-50/30 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold shrink-0">
                              {(displayName || "?")[0]?.toUpperCase()}
                            </div>
                            <span className="font-medium truncate">{c.first_name || "—"}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="truncate">{c.last_name || "—"}</span>
                        </td>
                        <td className="px-4 py-3 text-muted hidden lg:table-cell">
                          {c.email ? (
                            <span className="text-xs bg-gray-50 px-2 py-0.5 rounded">{c.email}</span>
                          ) : (
                            <span className="text-xs text-muted/40">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-muted">+{c.phone}</td>
                        <td className="px-4 py-3 hidden md:table-cell">
                          {batch && (
                            <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-gray-50 border border-border/60">
                              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: batchColor(batch) }} />
                              {batch.tag}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-medium ${
                            c.wa_status === "yes" ? "bg-green-100 text-green-700" :
                            c.wa_status === "no" ? "bg-red-50 text-red-600" :
                            "bg-gray-100 text-gray-500"
                          }`}>
                            {c.wa_status === "yes" ? (
                              <><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" className="text-green-600"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> WhatsApp</>
                            ) : c.wa_status === "no" ? (
                              <><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg> No WA</>
                            ) : (
                              <><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10" /><path d="M12 16v.01M12 8v4" /></svg> Unchecked</>
                            )}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-border text-sm text-muted shrink-0 bg-white">
              <span>{total} contacts total</span>
              <div className="flex items-center gap-2">
                <button disabled={page === 0} onClick={() => setPage(page - 1)} className="px-3 py-1.5 rounded-lg border border-border disabled:opacity-40 hover:bg-gray-50 transition-colors">Prev</button>
                <span className="text-xs font-medium">{page + 1} / {totalPages}</span>
                <button disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)} className="px-3 py-1.5 rounded-lg border border-border disabled:opacity-40 hover:bg-gray-50 transition-colors">Next</button>
              </div>
            </div>
          )}
        </main>
      </div>

      {showUpload && (
        <UploadContactsDialog
          onClose={() => setShowUpload(false)}
          onDone={() => { setShowUpload(false); loadBatches(); }}
        />
      )}
    </div>
  );
}
