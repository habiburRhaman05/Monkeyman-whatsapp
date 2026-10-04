"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getMedia, type Message } from "@/lib/api";
import { retry, reactMessage, forwardMsg, deleteMsg, toggleStar } from "@/lib/actions";
import { useStore } from "@/lib/store";
import { avatarColor, chatTitle, formatTime } from "@/lib/util";
import { REACTION_EMOJIS } from "./EmojiPicker";

const LABELS: Record<string, string> = {
  image: "Image",
  video: "Video",
  audio: "Voice message",
  document: "Document",
  sticker: "Sticker",
  other: "Unsupported message",
};

function Ticks({ status }: { status: Message["status"] }) {
  if (status === "pending") return <span className="text-muted" title="Sending">◷</span>;
  if (status === "sent") return <span className="text-muted" title="Sent">✓</span>;
  if (status === "delivered") return <span className="text-muted" title="Delivered">✓✓</span>;
  if (status === "read") return <span className="text-sky-500" title="Read">✓✓</span>;
  return <span className="text-danger font-bold" title="Failed">!</span>;
}

/** Full-screen image/video preview lightbox */
function ImagePreview({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = "";
    };
  }, [handleKey]);

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/85" />

      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 z-10 w-10 h-10 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center text-white transition-colors"
        title="Close (Esc)"
      >
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>

      {/* Download button */}
      <a
        href={src}
        download={alt}
        onClick={(e) => e.stopPropagation()}
        className="absolute top-4 right-16 z-10 w-10 h-10 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center text-white transition-colors"
        title="Download"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
        </svg>
      </a>

      {/* Image */}
      <img
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        className="relative z-10 max-w-[92vw] max-h-[92vh] object-contain rounded-lg shadow-2xl"
      />
    </div>,
    document.body,
  );
}

/** Deterministic pseudo-random bar heights, so a given recording's waveform looks the same on every render. */
function seededBars(seed: string, count: number): number[] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const bars: number[] = [];
  for (let i = 0; i < count; i++) {
    h = (h * 1103515245 + 12345) >>> 0;
    bars.push(0.3 + ((h >>> 8) % 100) / 100 * 0.7); // 30%-100% height
  }
  return bars;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** WhatsApp-style voice note: play button, scrubbable waveform, time, sender avatar with a mic badge. */
function VoiceNote({ url, mine, label, picUrl }: { url: string; mine: boolean; label: string; picUrl?: string | null }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const bars = useMemo(() => seededBars(url, 48), [url]);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setCurrent(el.currentTime);
    const onLoaded = () => setDuration(el.duration || 0);
    const onEnd = () => { setPlaying(false); setCurrent(0); };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onLoaded);
    el.addEventListener("ended", onEnd);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onLoaded);
      el.removeEventListener("ended", onEnd);
    };
  }, []);

  function toggle() {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
    } else {
      el.playbackRate = speed;
      el.play().catch(() => {});
      setPlaying(true);
    }
  }

  function cycleSpeed() {
    const next = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1;
    setSpeed(next);
    const el = audioRef.current;
    if (el) el.playbackRate = next;
  }

  function seek(e: React.MouseEvent<HTMLDivElement>) {
    const el = audioRef.current;
    if (!el || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    el.currentTime = fraction * duration;
    setCurrent(el.currentTime);
  }

  const progress = duration ? current / duration : 0;
  const initial = (label.replace(/^\+/, "").trim()[0] || "?").toUpperCase();
  const playedIdx = Math.floor(progress * bars.length);

  return (
    <div className="flex items-center gap-2.5 py-1 min-w-[260px]">
      <audio ref={audioRef} src={url} preload="metadata" className="hidden" />
      {/* Play/pause */}
      <button
        onClick={toggle}
        title={playing ? "Pause" : "Play"}
        className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 bg-transparent text-[#54656f] hover:text-[#3b4a54]"
      >
        {playing ? (
          <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
            <path d="M7 4v16l13-8z" />
          </svg>
        )}
      </button>
      {/* Waveform + time */}
      <div className="flex-1 min-w-0">
        <div className="flex items-end gap-[1.5px] h-[28px] cursor-pointer" onClick={seek}>
          {bars.map((h, i) => (
            <span
              key={i}
              className="rounded-full shrink-0 transition-colors"
              style={{
                width: 3,
                height: `${Math.max(h * 100, 12)}%`,
                background: i <= playedIdx
                  ? "#00a884"
                  : mine ? "rgba(255,255,255,0.45)" : "#b8c1c8",
              }}
            />
          ))}
        </div>
        <div className="flex items-center justify-between mt-1">
          <span className={`text-[11px] ${mine ? "text-white/70" : "text-muted"}`}>
            {mmss(playing || current > 0 ? current : duration)}
          </span>
          {playing && (
            <button onClick={cycleSpeed} className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${mine ? "text-white/80 bg-white/15" : "text-muted bg-black/5"}`}>
              {speed}x
            </button>
          )}
        </div>
      </div>
      {/* Avatar with mic badge */}
      <div className="relative shrink-0">
        {picUrl ? (
          <img src={picUrl} alt={label} className="w-11 h-11 rounded-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; (e.target as HTMLImageElement).nextElementSibling as HTMLElement && ((e.target as HTMLImageElement).parentElement!.querySelector(".av-fallback") as HTMLElement)?.classList.remove("hidden"); }} />
        ) : null}
        <span
          className={`${picUrl ? "av-fallback hidden" : ""} w-11 h-11 rounded-full flex items-center justify-center text-white text-sm font-semibold`}
          style={{ background: avatarColor(label) }}
        >
          {initial}
        </span>
        <span className="absolute -bottom-0.5 -right-0.5 w-[18px] h-[18px] rounded-full bg-[#00a884] border-2 border-white flex items-center justify-center">
          <svg viewBox="0 0 24 24" width="9" height="9" fill="white">
            <rect x="9" y="2" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0014 0" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" />
            <line x1="12" y1="18" x2="12" y2="22" stroke="white" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </span>
      </div>
    </div>
  );
}

export function Media({ msg, compact }: { msg: Message; compact?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [preview, setPreview] = useState(false);
  const label = LABELS[msg.type] ?? "Media";
  const canLoad = msg.id > 0 && !msg.wa_message_id.startsWith("pending-") && msg.type !== "other";
  const isVisual = msg.type === "image" || msg.type === "sticker" || msg.type === "video";

  // Auto-load images and videos when they appear
  useEffect(() => {
    if (canLoad && isVisual && !url && state === "idle") {
      setState("loading");
      getMedia(msg.account_id, msg.id)
        .then((r) => { setUrl(r.data_url); setState("idle"); })
        .catch(() => setState("error"));
    }
  }, [canLoad, isVisual, url, state, msg.account_id, msg.id]);

  async function load() {
    setState("loading");
    try {
      const r = await getMedia(msg.account_id, msg.id);
      setUrl(r.data_url);
      setState("idle");
    } catch {
      setState("error");
    }
  }

  if (url) {
    if (msg.type === "audio") return <VoiceNote url={url} mine={msg.from_me} label={msg.from_me ? "You" : msg.sender_name || "Contact"} />;
    if (msg.type === "image" || msg.type === "sticker")
      return (
        <>
          <img
            src={url}
            alt={label}
            className={`rounded-lg max-w-full cursor-pointer hover:brightness-95 transition ${compact ? "max-h-20" : "max-h-72"}`}
            onClick={() => setPreview(true)}
          />
          {preview && (
            <ImagePreview
              src={url}
              alt={msg.media_filename || label}
              onClose={() => setPreview(false)}
            />
          )}
        </>
      );
    if (msg.type === "video")
      return (
        <video controls src={url} className={`rounded-lg max-w-full ${compact ? "max-h-20" : "max-h-72"}`} />
      );
    return (
      <a href={url} download={msg.media_filename || label} className="text-sky-600 underline text-sm">
        Download {msg.media_filename || label.toLowerCase()}
      </a>
    );
  }

  // Loading / placeholder state for images
  if (isVisual && state === "loading") {
    return (
      <div className={`rounded-lg bg-black/5 flex items-center justify-center ${compact ? "w-16 h-16" : "w-48 h-32"}`}>
        <div className="text-muted text-sm animate-pulse">Loading…</div>
      </div>
    );
  }
  if (isVisual && state === "error") {
    return (
      <button onClick={load} className={`rounded-lg bg-black/5 flex items-center justify-center cursor-pointer hover:bg-black/10 ${compact ? "w-16 h-16" : "w-48 h-32"}`}>
        <div className="text-muted text-xs text-center px-2">Tap to retry</div>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="italic text-muted">[{label}]{msg.media_filename ? ` ${msg.media_filename}` : ""}</span>
      {canLoad && (
        <button onClick={load} disabled={state === "loading"} className="text-primary hover:underline disabled:opacity-60">
          {state === "loading" ? "Loading…" : state === "error" ? "Unavailable – retry" : msg.type === "audio" ? "▶ Play" : "Open"}
        </button>
      )}
    </div>
  );
}

function quotedSenderLabel(sender: string): string {
  if (!sender.includes("@")) return sender; // already a name, or "You"
  const digits = sender.split("@")[0].split(":")[0];
  return /^\d+$/.test(digits) ? `+${digits}` : "Unknown";
}

/** Scroll to the replied-to message if it is loaded, and flash it. */
function jumpToQuoted(msg: Message) {
  const target = useStore.getState().messages[msg.chat_id]?.find((m) => m.wa_message_id === msg.quoted?.message_id);
  const el = target ? document.getElementById(`msg-${target.id}`) : null;
  if (!el) {
    useStore.getState().pushToast({ kind: "info", title: "Original message is not loaded", body: "Scroll up to load older messages." });
    return;
  }
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("bg-yellow-100/70");
  setTimeout(() => el.classList.remove("bg-yellow-100/70"), 1500);
}

function QuotedMessage({ msg, mine }: { msg: Message; mine: boolean }) {
  const quoted = msg.quoted;
  if (!quoted) return null;
  const sender = quoted.sender ? quotedSenderLabel(quoted.sender) : null;
  const senderColor = sender === "You" ? "var(--primary)" : sender ? avatarColor(sender) : "var(--primary)";
  const isMedia = quoted.type && quoted.type !== "text";
  const mediaIcon = isMedia ? LABELS[quoted.type!] || quoted.type : null;
  const previewText = quoted.text || (isMedia ? "" : "Message");

  return (
    <button
      type="button"
      onClick={() => jumpToQuoted(msg)}
      className={`block w-full text-left rounded-lg mb-1 overflow-hidden transition-colors ${
        mine ? "bg-[#c8e6b8] hover:bg-[#bfddaf]" : "bg-[#f0f0f0] hover:bg-[#e6e6e6]"
      }`}
    >
      <div className="flex min-h-[42px]">
        {/* Colored left bar */}
        <div className="w-1 shrink-0 rounded-l-lg" style={{ background: senderColor }} />
        {/* Content */}
        <div className="flex-1 min-w-0 px-2.5 py-1.5">
          {sender && (
            <div className="text-[13px] font-semibold truncate leading-tight" style={{ color: senderColor }}>
              {sender}
            </div>
          )}
          <div className="flex items-center gap-1 mt-0.5">
            {mediaIcon && (
              <span className="text-muted shrink-0">
                {quoted.type === "image" && (
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" />
                  </svg>
                )}
                {quoted.type === "video" && (
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" />
                  </svg>
                )}
                {quoted.type === "audio" && (
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0014 0M12 18v4" />
                  </svg>
                )}
                {quoted.type === "document" && (
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
                  </svg>
                )}
                {quoted.type === "sticker" && "🎭"}
              </span>
            )}
            <span className="text-[13px] text-muted line-clamp-1 break-words leading-tight">
              {mediaIcon && !previewText ? mediaIcon : previewText}
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}

function ContextMenu({ msg, accountId, onClose }: { msg: Message; accountId: number; onClose: () => void }) {
  const chats = useStore((s) => (s.activeAccountId ? s.chats[s.activeAccountId] : []));
  const [showForward, setShowForward] = useState(false);
  const [showReactions, setShowReactions] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const sent = msg.status !== "pending" && msg.status !== "failed";
  const [canEdit] = useState(
    () => msg.from_me && msg.type === "text" && sent && Date.now() - new Date(msg.timestamp).getTime() < 14 * 60 * 1000,
  );

  if (showDelete) {
    return (
      <div className="absolute z-50 bg-white rounded-lg shadow-lg border border-border py-1 w-44" style={{ bottom: "100%", right: 0 }}>
        <div className="text-xs font-medium text-muted px-3 py-1">Delete message?</div>
        {msg.from_me && sent && (
          <button
            onClick={() => { deleteMsg(msg, "everyone"); onClose(); }}
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 text-danger"
          >
            Delete for everyone
          </button>
        )}
        <button
          onClick={() => { deleteMsg(msg, "me"); onClose(); }}
          className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          Delete for me
        </button>
        <p className="px-3 pb-1 text-[11px] text-muted">&quot;For me&quot; hides it here only; it stays on your phone.</p>
      </div>
    );
  }

  if (showForward) {
    return (
      <div className="absolute z-50 bg-white rounded-lg shadow-lg border border-border p-2 w-52 max-h-48 overflow-y-auto" style={{ bottom: "100%", right: 0 }}>
        <div className="text-xs font-medium text-muted mb-1 px-1">Forward to:</div>
        {(chats || []).map((c) => (
          <button
            key={c.id}
            onClick={() => {
              forwardMsg(accountId, msg.id, c.id);
              onClose();
            }}
            className="w-full text-left px-2 py-1.5 text-sm hover:bg-gray-50 rounded truncate"
          >
            {chatTitle(c)}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="absolute z-50 bg-white rounded-lg shadow-lg border border-border py-1 w-36" style={{ bottom: "100%", right: 0 }}>
      <button
        onClick={() => {
          useStore.getState().setReplyTo({
            id: msg.id,
            wa_message_id: msg.wa_message_id,
            sender_name: msg.sender_name,
            from_me: msg.from_me,
            text: msg.text,
            type: msg.type,
          });
          onClose();
        }}
        className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50"
      >
        Reply
      </button>
      {canEdit && (
        <button
          onClick={() => { useStore.getState().setEditing(msg); onClose(); }}
          className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          Edit
        </button>
      )}
      <button
        onClick={() => { toggleStar(msg); onClose(); }}
        className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50"
      >
        {msg.starred ? "Unstar" : "Star"}
      </button>
      <button
        onClick={() => setShowReactions(!showReactions)}
        className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50"
      >
        React
      </button>
      {showReactions && (
        <div className="flex gap-1 px-2 pb-1">
          {REACTION_EMOJIS.map((e) => (
            <button
              key={e}
              onClick={() => {
                reactMessage(msg, e);
                onClose();
              }}
              className="text-lg hover:scale-125 transition-transform"
            >
              {e}
            </button>
          ))}
        </div>
      )}
      {msg.type === "text" && msg.text && (
        <button
          onClick={() => setShowForward(true)}
          className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          Forward
        </button>
      )}
      <button
        onClick={() => {
          if (msg.text) navigator.clipboard?.writeText(msg.text);
          onClose();
        }}
        className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50"
      >
        Copy
      </button>
      <button onClick={() => setShowDelete(true)} className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 text-danger">
        Delete
      </button>
    </div>
  );
}

export default function Bubble({ msg, isGroup, showName, accountId }: { msg: Message; isGroup: boolean; showName: boolean; accountId: number }) {
  const mine = msg.from_me;
  const [showMenu, setShowMenu] = useState(false);

  if (msg.deleted) {
    return (
      <div className={`flex ${mine ? "justify-end" : "justify-start"} px-3`}>
        <div className={`rounded-lg px-2.5 py-1.5 shadow-sm text-sm italic text-muted ${mine ? "bg-bubble-mine" : "bg-bubble-theirs"}`}>
          🚫 {mine ? "You deleted this message" : "This message was deleted"}
          <span className="ml-2 text-[11px] not-italic">{formatTime(msg.timestamp)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"} px-3 group relative`}>
      <div
        className={`max-w-[82%] md:max-w-[65%] rounded-lg px-2.5 py-1.5 shadow-sm relative ${
          mine ? "bg-bubble-mine rounded-tr-none" : "bg-bubble-theirs rounded-tl-none"
        }`}
      >
        {isGroup && !mine && showName && msg.sender_name && (
          <div className="text-xs font-semibold mb-0.5" style={{ color: avatarColor(msg.sender_name) }}>
            {msg.sender_name}
          </div>
        )}

        <QuotedMessage msg={msg} mine={mine} />

        {msg.type !== "text" && <Media msg={msg} />}
        {msg.text && !(msg.type === "document" && msg.text === msg.media_filename) && (
          <div className="whitespace-pre-wrap break-words text-[15px]">{msg.text}</div>
        )}

        <div className="flex items-center justify-end gap-1.5 mt-0.5 text-[11px] text-muted">
          {msg.status === "failed" && mine && (
            <>
              {msg.type === "text" && msg.id > 0 ? (
                <button
                  onClick={() => retry(msg.account_id, msg.id, msg.chat_id)}
                  className="text-danger font-medium hover:underline"
                >
                  Retry
                </button>
              ) : (
                <span className="text-danger">Not sent</span>
              )}
            </>
          )}
          {msg.starred && <span className="text-yellow-500" title="Starred">★</span>}
          {msg.edited && <span className="italic">edited</span>}
          <span>{formatTime(msg.timestamp)}</span>
          {mine && <Ticks status={msg.status} />}
        </div>

        {!!msg.reactions?.length && (
          <div className={`flex flex-wrap gap-1 mt-1 ${mine ? "justify-end" : ""}`}>
            {msg.reactions.map((r) => (
              <button
                key={r.emoji}
                onClick={() => reactMessage(msg, r.emoji)}
                title={r.mine ? "Click to remove your reaction" : "React with this"}
                className={`text-xs px-1.5 py-0.5 rounded-full border ${r.mine ? "bg-primary/10 border-primary/40" : "bg-white border-border"}`}
              >
                {r.emoji}
                {r.count > 1 ? ` ${r.count}` : ""}
              </button>
            ))}
          </div>
        )}

        {/* Context menu trigger */}
        {msg.id > 0 && !msg.wa_message_id.startsWith("pending-") && (
          <button
            onClick={() => setShowMenu(!showMenu)}
            className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-black/5 transition-opacity"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" className="text-muted">
              <circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" />
            </svg>
          </button>
        )}
        {showMenu && <ContextMenu msg={msg} accountId={accountId} onClose={() => setShowMenu(false)} />}
      </div>
    </div>
  );
}
