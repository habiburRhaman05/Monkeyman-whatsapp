"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useStore } from "@/lib/store";
import { openChat, switchAccount } from "@/lib/actions";
import TopBar from "@/components/TopBar";
import ChatList from "@/components/ChatList";
import Conversation from "@/components/Conversation";

export default function Home() {
  const loaded = useStore((s) => s.accountsLoaded);
  const accounts = useStore((s) => s.accounts);
  const activeAccountId = useStore((s) => s.activeAccountId);
  const activeChatId = useStore((s) => s.activeChatId);
  const started = useRef(false);

  // Pick the starting number/chat once: URL params first, then the first connected number.
  useEffect(() => {
    if (!loaded || started.current || accounts.length === 0) return;
    started.current = true;
    const p = new URLSearchParams(window.location.search);
    const wantAccount = Number(p.get("account"));
    const wantChat = Number(p.get("chat"));
    const acc =
      accounts.find((a) => a.id === wantAccount) ?? accounts.find((a) => a.status === "connected") ?? accounts[0];
    if (useStore.getState().activeAccountId === acc.id) return; // already opened (e.g. from a notification)
    if (wantChat && acc.id === wantAccount) openChat(acc.id, wantChat);
    else switchAccount(acc.id);
  }, [loaded, accounts]);

  if (!loaded) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-muted animate-pulse">Loading…</p>
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-2xl font-semibold">Welcome</h1>
        <p className="text-muted max-w-sm">Connect your first WhatsApp number to see chats and send messages.</p>
        <Link href="/accounts" className="px-5 py-2.5 rounded-lg bg-primary text-white font-medium hover:bg-primary-dark">
          Connect a number
        </Link>
      </div>
    );
  }

  const chatOpen = activeChatId !== null && activeAccountId !== null;

  return (
    <div className="h-dvh flex flex-col">
      <TopBar />
      <div className="flex-1 flex min-h-0">
        <aside className={`${chatOpen ? "hidden md:flex" : "flex"} w-full md:w-[380px] md:shrink-0 border-r border-border flex-col min-h-0`}>
          <ChatList />
        </aside>
        <main className={`${chatOpen ? "flex" : "hidden md:flex"} flex-1 min-w-0 min-h-0`}>
          <Conversation />
        </main>
      </div>
    </div>
  );
}
