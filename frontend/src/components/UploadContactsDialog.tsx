"use client";

import { useRef, useState } from "react";
import { useStore } from "@/lib/store";
import * as api from "@/lib/api";

type Step = "pick" | "map" | "done";

interface Props {
  onClose: () => void;
  onDone: () => void;
}

export default function UploadContactsDialog({ onClose, onDone }: Props) {
  const labels = useStore((s) => s.labels);
  const [step, setStep] = useState<Step>("pick");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<api.UploadPreview | null>(null);
  const [mapping, setMapping] = useState<{
    first_name: string | null;
    last_name: string | null;
    name: string | null;
    email: string | null;
    phone: string | null;
    country_code: string | null;
    country_name: string | null;
  }>({ first_name: null, last_name: null, name: null, email: null, phone: null, country_code: null, country_name: null });
  const [tag, setTag] = useState("");
  const [defaultCC, setDefaultCC] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<api.UploadResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(f: File) {
    setFile(f);
    setError("");
    setLoading(true);
    try {
      const p = await api.previewUpload(f);
      setPreview(p);
      setMapping(p.mapping);
      setStep("map");
    } catch (e: unknown) {
      setError(e instanceof api.ApiError ? e.detail : "Failed to parse file");
    } finally {
      setLoading(false);
    }
  }

  async function doUpload() {
    if (!file || !tag.trim() || !mapping.phone) return;
    setError("");
    setLoading(true);
    try {
      const r = await api.uploadContacts(file, tag.trim(), mapping, defaultCC || undefined);
      setResult(r);
      const existing = useStore.getState().labels;
      if (!existing.find((l) => l.id === r.label.id)) {
        useStore.getState().setLabels([...existing, r.label].sort((a, b) => a.name.localeCompare(b.name)));
      }
      setStep("done");
    } catch (e: unknown) {
      setError(e instanceof api.ApiError ? e.detail : "Upload failed");
    } finally {
      setLoading(false);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }

  const mappingFields = [
    { key: "phone" as const, label: "Phone *", required: true, hint: "Required — the phone number column" },
    { key: "first_name" as const, label: "First name", required: false, hint: "" },
    { key: "last_name" as const, label: "Last name", required: false, hint: "" },
    { key: "name" as const, label: "Full name", required: false, hint: "If no first/last, we'll split it for you" },
    { key: "email" as const, label: "Email", required: false, hint: "" },
    { key: "country_code" as const, label: "Country code", required: false, hint: "e.g. column with 1, 44, 880" },
    { key: "country_name" as const, label: "Country name", required: false, hint: "e.g. USA, Bangladesh — auto-converts to dial code" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-gray-50/50">
          <div>
            <h2 className="font-semibold text-lg">Upload Contacts</h2>
            <p className="text-xs text-muted mt-0.5">
              {step === "pick" ? "CSV or XLSX file" : step === "map" ? "Map columns & tag" : "Done!"}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-gray-100 text-muted transition-colors">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Steps indicator */}
        <div className="px-5 py-2.5 border-b border-border/50 flex items-center gap-2">
          {["Choose file", "Map & upload", "Done"].map((s, i) => {
            const stepIdx = step === "pick" ? 0 : step === "map" ? 1 : 2;
            const active = i === stepIdx;
            const done = i < stepIdx;
            return (
              <div key={s} className="flex items-center gap-2">
                {i > 0 && <div className={`w-8 h-px ${done || active ? "bg-primary" : "bg-gray-200"}`} />}
                <div className={`flex items-center gap-1.5 text-xs font-medium ${active ? "text-primary" : done ? "text-green-600" : "text-muted"}`}>
                  <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${active ? "bg-primary text-white" : done ? "bg-green-100 text-green-600" : "bg-gray-100 text-gray-400"}`}>
                    {done ? "✓" : i + 1}
                  </span>
                  {s}
                </div>
              </div>
            );
          })}
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto flex-1">
          {error && (
            <div className="mb-4 px-3 py-2.5 text-sm bg-red-50 text-red-700 rounded-lg border border-red-100 flex items-start gap-2">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="mt-0.5 shrink-0"><circle cx="12" cy="12" r="10" /><path d="M15 9l-6 6M9 9l6 6" /></svg>
              {error}
            </div>
          )}

          {step === "pick" && (
            <div
              className={`border-2 border-dashed rounded-xl py-12 text-center transition-colors ${dragOver ? "border-primary bg-primary/5" : "border-gray-200 hover:border-primary/40"}`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
            >
              <input ref={inputRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
              <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-3">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" />
                </svg>
              </div>
              <button
                onClick={() => inputRef.current?.click()}
                disabled={loading}
                className="px-6 py-2.5 bg-primary text-white rounded-lg hover:bg-primary-dark disabled:opacity-50 font-medium text-sm"
              >
                {loading ? "Parsing…" : "Choose file"}
              </button>
              <p className="mt-3 text-sm text-muted">or drag & drop here</p>
              <p className="mt-1 text-xs text-muted/60">CSV, XLSX — max 5 MB, 20,000 rows</p>
            </div>
          )}

          {step === "map" && preview && (
            <>
              <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-lg bg-blue-50 border border-blue-100">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-blue-500 shrink-0"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>
                <span className="text-sm text-blue-700">
                  <strong>{preview.total_rows}</strong> rows in <strong>{file?.name}</strong>
                </span>
              </div>

              {/* Column mapping grid */}
              <div className="grid grid-cols-2 gap-3 mb-4">
                {mappingFields.map(({ key, label, hint }) => (
                  <div key={key}>
                    <label className="text-xs text-muted uppercase tracking-wider font-medium">{label}</label>
                    <select
                      value={mapping[key] || ""}
                      onChange={(e) => setMapping({ ...mapping, [key]: e.target.value || null })}
                      className={`w-full mt-1 px-3 py-2 text-sm border rounded-lg bg-white transition-colors ${
                        key === "phone" && !mapping.phone ? "border-red-300 focus:ring-red-200" : "border-border focus:ring-primary/30"
                      } focus:outline-none focus:ring-2`}
                    >
                      <option value="">{key === "phone" ? "— Select —" : "— None —"}</option>
                      {preview.columns.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                    {hint && <p className="text-[10px] text-muted mt-0.5">{hint}</p>}
                  </div>
                ))}
              </div>

              {/* Default country code */}
              <div className="mb-4">
                <label className="text-xs text-muted uppercase tracking-wider font-medium">Default country code (if not in file)</label>
                <input
                  value={defaultCC}
                  onChange={(e) => setDefaultCC(e.target.value.replace(/[^\d]/g, ""))}
                  placeholder="e.g. 1 for US, 44 for UK, 880 for BD"
                  maxLength={4}
                  className="w-full mt-1 px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <p className="text-[10px] text-muted mt-0.5">
                  Only applied to numbers that look local (≤10 digits, no + prefix). Leave blank to import numbers as-is.
                </p>
              </div>

              {/* Tag */}
              <div className="mb-4">
                <label className="text-xs text-muted uppercase tracking-wider font-medium">Tag (label) *</label>
                <input
                  value={tag}
                  onChange={(e) => setTag(e.target.value)}
                  placeholder="e.g. Campaign Jan, Leads"
                  maxLength={40}
                  className={`w-full mt-1 px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 ${
                    !tag.trim() ? "border-red-300 focus:ring-red-200" : "border-border focus:ring-primary/30"
                  }`}
                  list="tag-suggestions"
                />
                <datalist id="tag-suggestions">
                  {labels.map((l) => <option key={l.id} value={l.name} />)}
                </datalist>
              </div>

              {/* Preview table */}
              {preview.rows.length > 0 && (
                <div className="mb-4 overflow-x-auto rounded-lg border border-border">
                  <p className="text-xs text-muted px-3 py-1.5 bg-gray-50 border-b border-border">
                    Preview — first {preview.rows.length} rows
                  </p>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-gray-50/50">
                        {preview.columns.map((c) => {
                          const mappedAs = Object.entries(mapping).find(([, v]) => v === c)?.[0];
                          return (
                            <th key={c} className={`px-2 py-1.5 text-left border-b border-border font-medium ${mappedAs ? "bg-primary/5" : ""}`}>
                              <span>{c}</span>
                              {mappedAs && <span className="ml-1 text-[10px] text-primary font-semibold">→ {mappedAs}</span>}
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row, i) => (
                        <tr key={i} className="border-b border-border/50 last:border-0">
                          {preview.columns.map((c) => <td key={c} className="px-2 py-1.5 text-muted">{row[c] || ""}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex gap-2 justify-end">
                <button onClick={() => { setStep("pick"); setPreview(null); setFile(null); }} className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-gray-50 font-medium">
                  Back
                </button>
                <button
                  onClick={doUpload}
                  disabled={loading || !mapping.phone || !tag.trim()}
                  className="px-5 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary-dark disabled:opacity-50 font-medium"
                >
                  {loading ? "Uploading…" : `Upload ${preview.total_rows} contacts`}
                </button>
              </div>
            </>
          )}

          {step === "done" && result && (
            <div className="py-8 text-center">
              <div className="mx-auto w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mb-4">
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-600"><polyline points="20 6 9 17 4 12" /></svg>
              </div>
              <p className="font-semibold text-lg mb-1">Upload complete</p>
              <p className="text-sm text-muted mb-4">
                Tag: <span className="font-medium" style={{ color: result.label.color }}>{result.batch.tag}</span>
              </p>
              <div className="inline-grid grid-cols-3 gap-4 text-center mb-6">
                <div className="px-4 py-2 rounded-lg bg-green-50 border border-green-100">
                  <div className="text-lg font-bold text-green-700">{result.inserted}</div>
                  <div className="text-xs text-green-600">Imported</div>
                </div>
                {result.duplicates > 0 && (
                  <div className="px-4 py-2 rounded-lg bg-yellow-50 border border-yellow-100">
                    <div className="text-lg font-bold text-yellow-700">{result.duplicates}</div>
                    <div className="text-xs text-yellow-600">Duplicates</div>
                  </div>
                )}
                {result.invalid > 0 && (
                  <div className="px-4 py-2 rounded-lg bg-red-50 border border-red-100">
                    <div className="text-lg font-bold text-red-600">{result.invalid}</div>
                    <div className="text-xs text-red-500">Invalid</div>
                  </div>
                )}
              </div>
              <button onClick={() => { onDone(); onClose(); }} className="px-6 py-2.5 bg-primary text-white rounded-lg hover:bg-primary-dark font-medium">
                View contacts
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
