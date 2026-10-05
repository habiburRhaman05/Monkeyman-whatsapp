"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import * as api from "@/lib/api";

/**
 * Hard auth boundary for the whole app. Renders nothing (except the login page
 * itself) until a valid session token is confirmed against the backend —
 * API calls and the WebSocket are the real enforcement, this just keeps the UI
 * from flashing protected content before a redirect.
 */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const isLoginPage = pathname === "/login";

  useEffect(() => {
    let cancelled = false;

    async function check() {
      const token = api.getToken();
      if (!token) {
        if (isLoginPage) {
          if (!cancelled) setReady(true);
        } else {
          router.replace("/login");
        }
        return;
      }
      try {
        await api.me();
        if (cancelled) return;
        if (isLoginPage) router.replace("/");
        else setReady(true);
      } catch {
        api.clearToken();
        if (cancelled) return;
        if (isLoginPage) setReady(true);
        else router.replace("/login");
      }
    }

    check();
    return () => {
      cancelled = true;
    };
  }, [pathname, isLoginPage, router]);

  if (isLoginPage) return <>{children}</>;
  if (!ready) return null;
  return <>{children}</>;
}
