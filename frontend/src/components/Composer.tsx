"use client";

import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { sendTextMessage, sendVoiceMessage, sendMediaMessage, emitTyping, editMsg } from "@/lib/actions";
import { avatarColor, newClientId } from "@/lib/util";
import { getGroupInfo, type GroupParticipant } from "@/lib/api";
import EmojiPicker from "./EmojiPicker";
import QuickRepliesDialog from "./QuickRepliesDialog";

// Cached per chat so reopening a group doesn't refetch participants every time.
const groupParticipantsCache = new Map<number, GroupParticipant[]>();

const MAX_RECORD_SECONDS = 180;
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

const blobToBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(String(r.result).split(",", 2)[1] ?? "");
    r.onerror = reject;
    r.readAsDataURL(blob);
  });

export default function Composer({ accountId, chatId, disabled, isGroup }: { accountId: number; chatId: number; disabled: boolean; isGroup?: boolean }) {
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [showEmoji, setShowEmoji] = useState(false);
  const replyTo = useStore((s) => s.replyTo);
  const editing = useStore((s) => s.editing);
  const quickReplies = useStore((s) => s.quickReplies);
  const [showReplies, setShowReplies] = useState(false);
  const [qrIndex, setQrIndex] = useState(0);
  const [participants, setParticipants] = useState<GroupParticipant[]>([]);
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionMapRef = useRef<Map<string, string>>(new Map()); // "@Name" label -> phone digits, this compose session
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const cancelRef = useRef(false);
  const ctxRef = useRef({ accountId, chatId });
  ctxRef.current = { accountId, chatId };

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  useEffect(() => {
    setText("");
    cancelRef.current = true;
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
    setRecording(false);
    setShowEmoji(false);
    useStore.getState().setReplyTo(null);
    mentionMapRef.current.clear();
    setMentionStart(null);
    setMentionQuery(null);
    areaRef.current?.focus();
  }, [chatId]);

  // Group participants, for @mention — cached per chat.
  useEffect(() => {
    if (!isGroup) {
      setParticipants([]);
      return;
    }
    const cached = groupParticipantsCache.get(chatId);
    if (cached) {
      setParticipants(cached);
      return;
    }
    let alive = true;
    getGroupInfo(accountId, chatId)
      .then((info) => {
        if (!alive) return;
        const withPhone = info.participants.filter((p) => p.phone);
        groupParticipantsCache.set(chatId, withPhone);
        setParticipants(withPhone);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [accountId, chatId, isGroup]);

  // Start editing: load the message text into the box
  useEffect(() => {
    if (!editing) return;
    setText(editing.text ?? "");
    areaRef.current?.focus();
  }, [editing]);
  useEffect(() => () => { cancelRef.current = true; recorderRef.current?.state !== "inactive" && recorderRef.current?.stop(); stopStream(); }, []);

  useEffect(() => {
    if (!recording) return;
    setSeconds(0);
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);
  useEffect(() => {
    if (recording && seconds >= MAX_RECORD_SECONDS) finishRecording(false);
  }, [seconds, recording]);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
  }, [text]);

  function cancelEdit() {
    useStore.getState().setEditing(null);
    setText("");
  }

  async function send() {
    const t = text.trim();
    if (!t || disabled) return;
    const target = useStore.getState().editing;
    if (target) {
      if (t !== target.text && !(await editMsg(target, t))) return; // keep the text so the user can retry
      cancelEdit();
      return;
    }
    const reply = useStore.getState().replyTo;
    const mentioned = isGroup
      ? Array.from(mentionMapRef.current.entries())
          .filter(([label]) => t.includes(`@${label}`))
          .map(([, phone]) => phone)
      : undefined;
    setText("");
    useStore.getState().setReplyTo(null);
    mentionMapRef.current.clear();
    sendTextMessage(accountId, chatId, t, newClientId(), reply?.wa_message_id, mentioned?.length ? mentioned : undefined);
  }

  // "/thanks" at the start of the box (no spaces yet) suggests matching quick replies
  const slash = !editing && text.startsWith("/") && !/\s/.test(text) ? text.slice(1).toLowerCase() : null;
  const matches = slash === null ? [] : quickReplies.filter((r) => r.shortcut.startsWith(slash)).slice(0, 6);
  const activeMatch = Math.min(qrIndex, Math.max(matches.length - 1, 0));

  function pickReply(body: string) {
    setText(body);
    setQrIndex(0);
    areaRef.current?.focus();
  }

  // "@Name" mentions, in groups only
  const mentionMatches =
    isGroup && mentionQuery !== null
      ? participants
          .filter((p) => (p.name || p.phone || "").toLowerCase().includes(mentionQuery.toLowerCase()))
          .slice(0, 6)
      : [];
  const activeMention = Math.min(mentionIndex, Math.max(mentionMatches.length - 1, 0));

  function pickMention(p: GroupParticipant) {
    if (mentionStart === null || mentionQuery === null || !p.phone) return;
    const label = p.name || `+${p.phone}`;
    const before = text.slice(0, mentionStart);
    const after = text.slice(mentionStart + 1 + mentionQuery.length);
    const inserted = `@${label} `;
    setText(before + inserted + after);
    mentionMapRef.current.set(label, p.phone);
    setMentionStart(null);
    setMentionQuery(null);
    setMentionIndex(0);
    requestAnimationFrame(() => {
      const el = areaRef.current;
      if (!el) return;
      const pos = before.length + inserted.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  function handleInput(value: string, caret: number) {
    setQrIndex(0);
    setText(value);
    emitTyping(accountId, chatId);
    if (!isGroup || !participants.length) {
      setMentionStart(null);
      setMentionQuery(null);
      return;
    }
    const upto = value.slice(0, caret);
    const at = upto.lastIndexOf("@");
    const isWordStart = at !== -1 && (at === 0 || /\s/.test(upto[at - 1]));
    if (isWordStart && !/\s/.test(upto.slice(at + 1))) {
      setMentionStart(at);
      setMentionQuery(upto.slice(at + 1));
      setMentionIndex(0);
    } else {
      setMentionStart(null);
      setMentionQuery(null);
    }
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || disabled) return;
    e.target.value = "";
    if (file.size > 50 * 1024 * 1024) {
      useStore.getState().pushToast({ kind: "error", title: "File too large", body: "Maximum size is ~37 MB" });
      return;
    }
    const reply = useStore.getState().replyTo;
    useStore.getState().setReplyTo(null);
    sendMediaMessage(accountId, chatId, file, "", newClientId(), reply?.wa_message_id);
  }

  async function startRecording() {
    if (disabled || recording) return;
    const st = useStore.getState();
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      st.pushToast({ kind: "error", title: "Voice recording unavailable", body: "Open the dashboard on localhost or https." });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      cancelRef.current = false;
      const target = { ...ctxRef.current };
      rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      rec.onstop = async () => {
        stopStream();
        const chunks = chunksRef.current;
        chunksRef.current = [];
        if (cancelRef.current || !chunks.length) return;
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        if (blob.size < 1500) {
          useStore.getState().pushToast({ kind: "info", title: "Recording too short" });
          return;
        }
        try {
          const b64 = await blobToBase64(blob);
          sendVoiceMessage(target.accountId, target.chatId, b64, newClientId());
        } catch {
          useStore.getState().pushToast({ kind: "error", title: "Could not read the recording" });
        }
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      stopStream();
      st.pushToast({ kind: "error", title: "Microphone unavailable", body: "Allow microphone access in your browser." });
    }
  }

  function finishRecording(cancel: boolean) {
    cancelRef.current = cancel;
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    setRecording(false);
  }

  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const iconBtn = "p-2.5 rounded-full shrink-0 transition-colors";

  if (disabled) {
    return (
      <div className="px-4 py-3 bg-background border-t border-border text-sm text-muted text-center">
        This number is not connected. Reconnect it to send messages.
      </div>
    );
  }

  return (
    <div className="bg-background border-t border-border shrink-0">
      {showReplies && <QuickRepliesDialog onPick={pickReply} onClose={() => setShowReplies(false)} />}
      {editing && (
        <div className="px-4 pt-2 pb-1">
          <div className="flex items-stretch bg-[#f0f2f5] rounded-lg overflow-hidden">
            <div className="w-1 shrink-0 bg-primary" />
            <div className="flex-1 min-w-0 px-3 py-2">
              <div className="text-[13px] font-semibold text-primary leading-tight flex items-center gap-1">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
                Edit message
              </div>
              <div className="text-[13px] text-muted truncate leading-tight mt-0.5">{editing.text}</div>
            </div>
            <button onClick={cancelEdit} className="px-3 flex items-center text-muted hover:text-foreground shrink-0" title="Cancel (Esc)">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Reply indicator — WhatsApp style */}
      {replyTo && (() => {
        const senderLabel = replyTo.from_me ? "You" : (replyTo.sender_name || "");
        const senderColor = replyTo.from_me ? "var(--primary)" : (replyTo.sender_name ? avatarColor(replyTo.sender_name) : "var(--primary)");
        const MEDIA_LABELS: Record<string, string> = { image: "📷 Photo", video: "🎥 Video", audio: "🎤 Voice message", document: "📄 Document", sticker: "🎭 Sticker" };
        const mediaLabel = replyTo.type !== "text" ? MEDIA_LABELS[replyTo.type] || replyTo.type : null;
        return (
          <div className="px-4 pt-2 pb-1">
            <div className="flex items-stretch bg-[#f0f2f5] rounded-lg overflow-hidden">
              <div className="w-1 shrink-0" style={{ background: senderColor }} />
              <div className="flex-1 min-w-0 px-3 py-2">
                <div className="text-[13px] font-semibold truncate leading-tight" style={{ color: senderColor }}>
                  {senderLabel}
                </div>
                <div className="text-[13px] text-muted truncate leading-tight mt-0.5">
                  {mediaLabel && !replyTo.text ? mediaLabel : (mediaLabel ? `${mediaLabel} ` : "") + (replyTo.text || "")}
                </div>
              </div>
              <button
                onClick={() => useStore.getState().setReplyTo(null)}
                className="px-3 flex items-center text-muted hover:text-foreground shrink-0"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        );
      })()}

      <div className="px-3 py-2 flex items-end gap-2">
        {recording ? (
          <>
            <button onClick={() => finishRecording(true)} title="Cancel" className={`${iconBtn} text-danger hover:bg-black/5`}>
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
              </svg>
            </button>
            <div className="flex-1 flex items-center gap-2 px-3 py-2.5 rounded-3xl bg-surface text-sm">
              <span className="w-2.5 h-2.5 rounded-full bg-danger animate-pulse" />
              Recording… {mmss}
            </div>
            <button onClick={() => finishRecording(false)} title="Send voice message" className={`${iconBtn} bg-primary text-white hover:bg-primary-dark`}>
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M2 21l21-9L2 3v7l15 2-15 2z" /></svg>
            </button>
          </>
        ) : (
          <>
            {/* Emoji button */}
            <div className="relative">
              <button
                onClick={() => setShowEmoji(!showEmoji)}
                title="Emoji"
                className={`${iconBtn} ${showEmoji ? "text-primary" : "text-muted"} hover:bg-black/5`}
              >
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                  <line x1="9" y1="9" x2="9.01" y2="9" />
                  <line x1="15" y1="9" x2="15.01" y2="9" />
                </svg>
              </button>
              {showEmoji && (
                <EmojiPicker
                  onSelect={(emoji) => {
                    setText((t) => t + emoji);
                    areaRef.current?.focus();
                  }}
                  onClose={() => setShowEmoji(false)}
                />
              )}
            </div>

            {/* Attachment button */}
            <button
              onClick={() => fileRef.current?.click()}
              title="Attach file"
              className={`${iconBtn} text-muted hover:bg-black/5`}
            >
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip,.rar"
              onChange={handleFile}
              className="hidden"
            />

            <button
              onClick={() => setShowReplies(true)}
              title="Quick replies"
              className={`${iconBtn} text-muted hover:bg-black/5`}
            >
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z" />
              </svg>
            </button>
            <div className="relative flex-1 min-w-0">
              {mentionMatches.length > 0 && (
                <div className="absolute bottom-full left-0 right-0 mb-2 bg-white rounded-xl shadow-lg border border-border overflow-hidden z-50 max-h-56 overflow-y-auto">
                  {mentionMatches.map((p, i) => {
                    const label = p.name || `+${p.phone}`;
                    return (
                      <button
                        key={p.jid}
                        onMouseDown={(e) => { e.preventDefault(); pickMention(p); }}
                        className={`w-full text-left px-3 py-2 flex items-center gap-2 ${i === activeMention ? "bg-background" : "hover:bg-background"}`}
                      >
                        <span
                          className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0"
                          style={{ background: avatarColor(label) }}
                        >
                          {label.replace(/^\+/, "").trim()[0]?.toUpperCase() || "?"}
                        </span>
                        <span className="text-sm font-medium truncate">{label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {mentionMatches.length === 0 && matches.length > 0 && (
                <div className="absolute bottom-full left-0 right-0 mb-2 bg-white rounded-xl shadow-lg border border-border overflow-hidden z-50">
                  {matches.map((r, i) => (
                    <button
                      key={r.id}
                      onMouseDown={(e) => { e.preventDefault(); pickReply(r.text); }}
                      className={`w-full text-left px-3 py-2 ${i === activeMatch ? "bg-background" : "hover:bg-background"}`}
                    >
                      <span className="text-sm font-medium text-primary">/{r.shortcut}</span>
                      <span className="ml-2 text-sm text-muted truncate">{r.text.slice(0, 80)}</span>
                    </button>
                  ))}
                </div>
              )}
            <textarea
              ref={areaRef}
              value={text}
              rows={1}
              placeholder="Type a message"
              onChange={(e) => handleInput(e.target.value, e.target.selectionStart ?? e.target.value.length)}
              onKeyDown={(e) => {
                if (mentionMatches.length > 0) {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    setMentionIndex((activeMention + (e.key === "ArrowDown" ? 1 : mentionMatches.length - 1)) % mentionMatches.length);
                    return;
                  }
                  if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    pickMention(mentionMatches[activeMention]);
                    return;
                  }
                  if (e.key === "Escape") {
                    setMentionStart(null);
                    setMentionQuery(null);
                    return;
                  }
                }
                if (matches.length > 0) {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    setQrIndex((activeMatch + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
                    return;
                  }
                  if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    pickReply(matches[activeMatch].text);
                    return;
                  }
                }
                if (e.key === "Escape" && useStore.getState().editing) {
                  cancelEdit();
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              className="w-full resize-none px-4 py-2.5 rounded-3xl bg-surface focus:outline-none text-[15px] max-h-36"
            />
            </div>
            {text.trim() ? (
              <button onClick={send} title="Send" className={`${iconBtn} bg-primary text-white hover:bg-primary-dark`}>
                <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M2 21l21-9L2 3v7l15 2-15 2z" /></svg>
              </button>
            ) : (
              <button onClick={startRecording} title="Record voice message" className={`${iconBtn} bg-primary text-white hover:bg-primary-dark`}>
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="2" width="6" height="12" rx="3" />
                  <path d="M5 11a7 7 0 0014 0M12 18v4" />
                </svg>
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
