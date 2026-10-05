"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import {
  createAccount,
  getQR,
  disconnectAccount,
  deleteAccount,
  ApiError,
  type Account,
} from "@/lib/api";
import { useStore } from "@/lib/store";
import { refreshAccounts } from "@/lib/actions";
import LogoutButton from "@/components/LogoutButton";

/* ── Status dot ─────────────────────────────────── */
function StatusDot({ status }: { status: string }) {
  const color =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-yellow-400 animate-pulse"
        : "bg-gray-400";
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${color}`} />;
}

/* ── QR Modal ───────────────────────────────────── */
function QRModal({
  account,
  qr,
  onClose,
}: {
  account: Account;
  qr: string | null;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface rounded-xl shadow-xl p-6 w-full max-w-sm mx-4">
        <h2 className="text-lg font-semibold mb-1">Connect "{account.label}"</h2>
        <p className="text-muted text-sm mb-4">
          Scan this QR code with WhatsApp on your phone.
        </p>

        <div className="flex items-center justify-center min-h-[264px]">
          {qr ? (
            <img
              src={qr.startsWith("data:") ? qr : `data:image/png;base64,${qr}`}
              alt="QR Code"
              className="w-64 h-64"
            />
          ) : (
            <div className="text-muted text-sm animate-pulse">
              Waiting for QR code…
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 mt-2">
          <StatusDot status={account.status} />
          <span className="text-sm capitalize">{account.status}</span>
        </div>

        <button
          onClick={onClose}
          className="mt-4 w-full py-2 rounded-lg border border-border text-foreground
                     hover:bg-background transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  );
}

/* ── Main page ──────────────────────────────────── */
export default function AccountsPage() {
  // Accounts, live status and QR codes come from the shared store (fed by the one WebSocket in the layout)
  const accounts = useStore((s) => s.accounts);
  const loaded = useStore((s) => s.accountsLoaded);
  const qrByAccount = useStore((s) => s.qr);
  const setQr = useStore((s) => s.setQr);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState("");

  const [qrAccountId, setQrAccountId] = useState<number | null>(null);
  const qrAccount = accounts.find((a) => a.id === qrAccountId) ?? null;

  useEffect(() => {
    refreshAccounts();
  }, []);

  // Close the QR modal as soon as the number connects
  useEffect(() => {
    if (qrAccount?.status === "connected") setQrAccountId(null);
  }, [qrAccount?.status]);

  // Fallback: re-fetch the QR every 20s while the modal is open
  useEffect(() => {
    if (qrAccountId === null) return;
    const id = setInterval(async () => {
      try {
        const resp = await getQR(qrAccountId);
        if (resp.qr_base64) setQr(qrAccountId, resp.qr_base64);
        if (resp.status === "connected") refreshAccounts();
      } catch {}
    }, 20000);
    return () => clearInterval(id);
  }, [qrAccountId, setQr]);

  async function handleCreate() {
    if (!label.trim()) return;
    setCreating(true);
    setError("");
    try {
      const acc = await createAccount(label.trim());
      await refreshAccounts();
      setLabel("");
      setShowAdd(false);
      openQR(acc);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Failed to create");
    } finally {
      setCreating(false);
    }
  }

  async function openQR(acc: Account) {
    setQrAccountId(acc.id);
    try {
      const resp = await getQR(acc.id);
      if (resp.qr_base64) setQr(acc.id, resp.qr_base64);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Could not get a QR code");
    }
  }

  async function handleDisconnect(acc: Account) {
    if (!confirm(`Disconnect "${acc.label}"?`)) return;
    try {
      await disconnectAccount(acc.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Disconnect failed");
    }
    refreshAccounts();
  }

  async function handleDelete(acc: Account) {
    if (!confirm(`Remove "${acc.label}"? This deletes the instance and its saved chats.`)) return;
    try {
      await deleteAccount(acc.id);
      useStore.getState().removeAccount(acc.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Remove failed");
    }
  }

  return (
    <div className="flex-1 flex flex-col">
      {/* Header */}
      <header className="bg-header-bg text-header-text px-4 py-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold">MonkeyMan - Campaigns</h1>
        <div className="flex items-center gap-2">
          <Link href="/" className="text-sm px-3 py-1.5 rounded-full bg-white/15 hover:bg-white/25">
            ← Back to chats
          </Link>
          <LogoutButton />
        </div>
      </header>

      <div className="flex-1 p-4 max-w-2xl mx-auto w-full">
        {error && !showAdd && (
          <p className="text-danger text-sm mb-3">{error}</p>
        )}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Your Numbers</h2>
          <button
            onClick={() => setShowAdd(true)}
            className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-dark
                       transition-colors text-sm font-medium"
          >
            + Connect a number
          </button>
        </div>

        {/* Add form */}
        {showAdd && (
          <div className="bg-surface rounded-lg border border-border p-4 mb-4">
            <label className="block text-sm font-medium mb-1">Label</label>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder='e.g. "Personal" or "Business"'
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="flex-1 px-3 py-2 border border-border rounded-lg bg-background
                           focus:outline-none focus:ring-2 focus:ring-primary text-sm"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              />
              <button
                onClick={handleCreate}
                disabled={creating || !label.trim()}
                className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-dark
                           disabled:opacity-50 text-sm font-medium"
              >
                {creating ? "Creating…" : "Create"}
              </button>
              <button
                onClick={() => {
                  setShowAdd(false);
                  setLabel("");
                }}
                className="px-3 py-2 text-muted hover:text-foreground text-sm"
              >
                Cancel
              </button>
            </div>
            {error && <p className="text-danger text-sm mt-2">{error}</p>}
          </div>
        )}

        {/* Account list */}
        {!loaded ? (
          <p className="text-muted text-center py-12 animate-pulse">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="text-muted text-center py-12">
            No numbers connected yet. Click &quot;Connect a number&quot; to start.
          </p>
        ) : (
          <div className="space-y-3">
            {accounts.map((acc) => (
              <div
                key={acc.id}
                className="bg-surface rounded-lg border border-border p-4 flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  <StatusDot status={acc.status} />
                  <div>
                    <div className="font-medium">{acc.label}</div>
                    <div className="text-sm text-muted">
                      {acc.phone_number
                        ? `+${acc.phone_number}`
                        : acc.status === "connecting"
                          ? "Waiting for QR scan…"
                          : "Not connected"}
                    </div>
                  </div>
                </div>

                <div className="flex gap-2">
                  {acc.status !== "connected" && (
                    <button
                      onClick={() => openQR(acc)}
                      className="px-3 py-1.5 text-sm bg-primary text-white rounded-lg
                                 hover:bg-primary-dark transition-colors"
                    >
                      {acc.status === "connecting" ? "Show QR" : "Reconnect"}
                    </button>
                  )}
                  {acc.status === "connected" && (
                    <button
                      onClick={() => handleDisconnect(acc)}
                      className="px-3 py-1.5 text-sm border border-border rounded-lg
                                 text-muted hover:text-foreground transition-colors"
                    >
                      Disconnect
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(acc)}
                    className="px-3 py-1.5 text-sm border border-danger/30 text-danger rounded-lg
                               hover:bg-danger/10 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* QR Modal */}
      {qrAccount && (
        <QRModal
          account={qrAccount}
          qr={qrByAccount[qrAccount.id] ?? null}
          onClose={() => setQrAccountId(null)}
        />
      )}
    </div>
  );
}
