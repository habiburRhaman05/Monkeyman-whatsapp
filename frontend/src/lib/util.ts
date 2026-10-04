import type { Chat, Contact } from "./api";

export const phoneFromJid = (jid: string) => jid.split("@")[0].split(":")[0];

// WhatsApp's hidden "@lid" ids are not phone numbers, so never show their digits as a number.
const noName = (jid: string, isGroup: boolean) =>
  isGroup ? "Group" : jid.endsWith("@lid") ? "WhatsApp user" : "+" + phoneFromJid(jid);

export function chatTitle(c: Pick<Chat, "name" | "jid" | "is_group"> & { custom_name?: string | null }): string {
  return c.custom_name || c.name || noName(c.jid, c.is_group);
}

/**
 * Resolve the display name for a chat using contacts + LID mapping.
 * Priority: custom_name > group name > direct contact > LID→phone→contact > non-numeric name > fallback
 */
export function resolveChatName(
  chat: Pick<Chat, "name" | "jid" | "is_group"> & { custom_name?: string | null },
  contactMap?: Map<string, Contact>,
  lidMap?: Record<string, string>,
): string {
  if (chat.custom_name?.trim()) return chat.custom_name.trim();

  if (chat.is_group || chat.jid.endsWith("@g.us")) {
    return chat.name?.trim() || "Group";
  }

  if (contactMap) {
    const direct = contactMap.get(chat.jid);
    if (direct?.name?.trim()) return direct.name.trim();
  }

  if (chat.jid.endsWith("@lid") && lidMap && contactMap) {
    const phoneJid = lidMap[chat.jid];
    if (phoneJid) {
      const contact = contactMap.get(phoneJid);
      if (contact?.name?.trim()) return contact.name.trim();
    }
  }

  const name = chat.name?.trim();
  if (name && !/^\+?\d+$/.test(name)) return name;

  if (chat.jid.endsWith("@lid")) return name || "WhatsApp user";
  return name || "+" + phoneFromJid(chat.jid);
}

export function contactTitle(c: Contact): string {
  return c.name || noName(c.jid, c.is_group);
}

export function formatListTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const yesterday = new Date(now.getTime() - 86400000);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { day: "2-digit", month: "short" });
}

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function formatDay(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === new Date(now.getTime() - 86400000).toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

export const newClientId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `c${Date.now()}${Math.random().toString(16).slice(2)}`;

export const avatarColor = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h} 45% 45%)`;
};

let audioCtx: AudioContext | null = null;
/** Soft two-note chime, generated with Web Audio (no asset needed). */
export function playChime() {
  try {
    audioCtx = audioCtx ?? new (window.AudioContext || (window as any).webkitAudioContext)();
    const ctx = audioCtx;
    if (ctx.state === "suspended") ctx.resume();
    const now = ctx.currentTime;
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.12, now + i * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 0.4);
    });
  } catch {}
}
