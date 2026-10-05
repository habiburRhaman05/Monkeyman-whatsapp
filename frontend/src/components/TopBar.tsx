"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { switchAccount } from "@/lib/actions";
import LogoutButton from "./LogoutButton";

export function StatusDot({ status }: { status: string }) {
  const color =
    status === "connected" ? "bg-green-400" : status === "connecting" ? "bg-yellow-300 animate-pulse" : "bg-gray-400";
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${color}`} />;
}

export function Badge({ n, className = "" }: { n: number; className?: string }) {
  if (n <= 0) return null;
  return (
    <span
      className={`inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full text-[11px] font-semibold leading-none ${className}`}
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

export default function TopBar() {
  const accounts = useStore((s) => s.accounts);
  const activeId = useStore((s) => s.activeAccountId);
  const muted = useStore((s) => s.muted);
  const setMuted = useStore((s) => s.setMuted);
  const wsUp = useStore((s) => s.wsUp);
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">("unsupported");

  useEffect(() => {
    if (typeof Notification !== "undefined") setPerm(Notification.permission);
  }, []);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    try {
      localStorage.setItem("wa-muted", next ? "1" : "0");
    } catch {}
  };

  const askPermission = async () => {
    try {
      setPerm(await Notification.requestPermission());
    } catch {}
  };

  return (
    <header className="bg-header-bg text-header-text flex items-center gap-3 px-3 py-2 shrink-0">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="font-semibold hidden sm:block shrink-0">WhatsApp</span>
        <div className="flex gap-1.5 overflow-x-auto py-0.5 min-w-0">
          {accounts.map((a) => (
            <button
              key={a.id}
              onClick={() => switchAccount(a.id)}
              title={a.phone_number ? `+${a.phone_number}` : a.label}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm whitespace-nowrap transition-colors ${
                a.id === activeId ? "bg-white text-header-bg font-medium" : "bg-white/15 hover:bg-white/25"
              }`}
            >
              <StatusDot status={a.status} />
              {a.label}
              <Badge n={a.unread_total} className="bg-danger text-white" />
            </button>
          ))}
          <Link
            href="/accounts"
            className="px-3 py-1.5 rounded-full text-sm bg-white/15 hover:bg-white/25 whitespace-nowrap"
          >
            + Add
          </Link>
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {!wsUp && <span className="text-xs bg-danger/90 rounded px-2 py-1 mr-1">offline</span>}
        {perm === "default" && (
          <button
            onClick={askPermission}
            className="text-xs bg-white/15 hover:bg-white/25 rounded-full px-3 py-1.5 whitespace-nowrap hidden md:block"
          >
            Enable desktop alerts
          </button>
        )}
        {perm === "denied" && (
          <span className="text-xs opacity-80 hidden md:block" title="Allow notifications for this site in your browser settings">
            Alerts blocked
          </span>
        )}
        <button
          onClick={toggleMute}
          aria-label={muted ? "Unmute notification sound" : "Mute notification sound"}
          title={muted ? "Sound off" : "Sound on"}
          className="p-2 rounded-full hover:bg-white/15"
        >
          {muted ? (
            <Icon d="M11 5L6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6" />
          ) : (
            <Icon d="M11 5L6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 010 7M19 5a10 10 0 010 14" />
          )}
        </button>
        <Link href="/contacts" className="text-sm px-3 py-1.5 rounded-full hover:bg-white/15 hidden sm:flex items-center gap-1.5">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
          </svg>
          Contacts
        </Link>
        <Link href="/campaigns" className="text-sm px-3 py-1.5 rounded-full hover:bg-white/15 hidden sm:flex items-center gap-1.5">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><path d="M22 6l-10 7L2 6" />
          </svg>
          Campaigns
        </Link>
        <Link href="/accounts" className="text-sm px-3 py-1.5 rounded-full hover:bg-white/15 hidden sm:block">
          Manage
        </Link>
        <LogoutButton className="hidden sm:block" />
      </div>
    </header>
  );
}
