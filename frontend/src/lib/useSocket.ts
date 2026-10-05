"use client";

import { useEffect, useRef } from "react";
import { API_BASE, getToken } from "./api";

type Handler = (msg: any) => void;

interface Options {
  onOpen?: (isReconnect: boolean) => void;
  onClose?: () => void;
}

/** ws(s) URL of the backend socket; relative bases ("/api") resolve against the page address. */
function wsUrl(): string {
  const base = /^https?:/.test(API_BASE)
    ? API_BASE.replace(/^http/, "ws") + "/ws"
    : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}${API_BASE}/ws`;
  const token = getToken();
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

/**
 * One WebSocket with auto-reconnect (1s -> 30s backoff).
 * Calls handlers[msg.type](msg) for each server event.
 */
export function useSocket(handlers: Record<string, Handler>, options: Options = {}) {
  const handlersRef = useRef(handlers);
  const optionsRef = useRef(options);
  handlersRef.current = handlers;
  optionsRef.current = options;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = 1000;
    let stopped = false;
    let everOpened = false;

    const connect = () => {
      ws = new WebSocket(wsUrl());
      ws.onopen = () => {
        delay = 1000;
        optionsRef.current.onOpen?.(everOpened);
        everOpened = true;
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          handlersRef.current[msg.type]?.(msg);
        } catch {}
      };
      ws.onclose = () => {
        if (stopped) return;
        optionsRef.current.onClose?.();
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30000);
      };
      ws.onerror = () => ws?.close();
    };

    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, []);
}
