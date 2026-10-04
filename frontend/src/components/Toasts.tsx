"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useStore, type Toast } from "@/lib/store";
import { openChat } from "@/lib/actions";

function ToastItem({ toast, onOpen }: { toast: Toast; onOpen: (t: Toast) => void }) {
  const dismiss = useStore((s) => s.dismissToast);

  useEffect(() => {
    const t = setTimeout(() => dismiss(toast.id), toast.kind === "error" ? 6000 : 5000);
    return () => clearTimeout(t);
  }, [toast.id, toast.kind, dismiss]);

  const accent =
    toast.kind === "message" ? "border-l-primary" : toast.kind === "error" ? "border-l-danger" : "border-l-blue-500";
  const clickable = toast.kind === "message";

  return (
    <div
      role={clickable ? "button" : "status"}
      onClick={() => {
        if (clickable) onOpen(toast);
        dismiss(toast.id);
      }}
      className={`pointer-events-auto w-80 max-w-[calc(100vw-2rem)] bg-surface border border-border border-l-4 ${accent}
                  rounded-lg shadow-lg px-4 py-3 ${clickable ? "cursor-pointer hover:bg-background" : ""}`}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate">{toast.title}</div>
          {toast.body && <div className="text-sm text-muted line-clamp-2 break-words">{toast.body}</div>}
        </div>
        <button
          aria-label="Dismiss"
          onClick={(e) => {
            e.stopPropagation();
            dismiss(toast.id);
          }}
          className="text-muted hover:text-foreground leading-none text-lg"
        >
          ×
        </button>
      </div>
    </div>
  );
}

export default function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const router = useRouter();
  const pathname = usePathname();

  const open = (t: Toast) => {
    if (t.accountId == null || t.chatId == null) return;
    if (pathname !== "/") router.push("/");
    openChat(t.accountId, t.chatId);
  };

  return (
    <div className="pointer-events-none fixed top-4 right-4 z-[100] flex flex-col gap-2 items-end">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onOpen={open} />
      ))}
    </div>
  );
}
