"use client";

import { useState, useRef, useEffect } from "react";

const CATEGORIES: { label: string; emojis: string[] }[] = [
  {
    label: "Smileys",
    emojis: ["😀","😃","😄","😁","😆","😅","🤣","😂","🙂","😊","😇","🥰","😍","🤩","😘","😗","😚","😙","🥲","😋","😛","😜","🤪","😝","🤑","🤗","🤭","🫢","🤫","🤔","🫡","🤐","🤨","😐","😑","😶","🫥","😏","😒","🙄","😬","🤥","😌","😔","😪","🤤","😴","😷","🤒","🤕","🤢","🤮","🥵","🥶","🥴","😵","🤯","🤠","🥳","🥸","😎","🤓","🧐","😕","🫤","😟","🙁","😮","😯","😲","😳","🥺","🥹","😦","😧","😨","😰","😥","😢","😭","😱","😖","😣","😞","😓","😩","😫","🥱","😤","😡","😠","🤬","😈","👿","💀","☠️","💩","🤡","👹","👺","👻","👽","👾","🤖"],
  },
  {
    label: "Gestures",
    emojis: ["👋","🤚","🖐️","✋","🖖","🫱","🫲","🫳","🫴","👌","🤌","🤏","✌️","🤞","🫰","🤟","🤘","🤙","👈","👉","👆","🖕","👇","☝️","🫵","👍","👎","✊","👊","🤛","🤜","👏","🙌","🫶","👐","🤲","🤝","🙏","💪","🦾","🦿","🦵","🦶","👂","🦻","👃","🧠","🫀","🫁","🦷","🦴","👀","👁️","👅","👄","🫦"],
  },
  {
    label: "Hearts",
    emojis: ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❤️‍🔥","❤️‍🩹","💖","💗","💓","💞","💕","💟","❣️","💘","💝","💌","🫶","😍","🥰","😘","😻","💏","💑"],
  },
  {
    label: "Objects",
    emojis: ["📱","💻","⌨️","🖥️","🖨️","📷","📹","🎥","📞","☎️","📟","📠","📺","📻","🎙️","🎚️","🎛️","🧭","⏱️","⏲️","⏰","🔔","📢","📣","✉️","📧","📨","📩","📝","📎","🔗","✂️","📐","📏","🗑️","🔒","🔓","🔑","🗝️","🛠️","⚙️","🧲","💡","🔦","🕯️","💰","💵","💸","📊","📈","📉"],
  },
  {
    label: "Nature",
    emojis: ["🌸","💐","🌷","🌹","🥀","🌺","🌻","🌼","🌱","🪴","🌲","🌳","🌴","🌵","🌾","🌿","☘️","🍀","🍁","🍂","🍃","🍄","🌰","🦀","🐚","🌊","🌈","☀️","🌤️","⛅","🌥️","☁️","🌦️","🌧️","⛈️","🌩️","🌪️","🌫️","🌬️","🌀","🌈","🔥","💧","🌊","❄️","☃️","⛄","💨"],
  },
  {
    label: "Food",
    emojis: ["🍏","🍎","🍐","🍊","🍋","🍌","🍉","🍇","🍓","🫐","🍈","🍒","🍑","🥭","🍍","🥥","🥝","🍅","🥑","🥦","🥬","🥒","🌶️","🫑","🌽","🥕","🫒","🧄","🧅","🥔","🍠","🫘","🥜","🍞","🥐","🥖","🫓","🥨","🥯","🧇","🧀","🍖","🍗","🥩","🥓","🍔","🍟","🍕","🌭","🥪","🌮","🌯","🫔","🥙","🧆","🥚","🍳","🥘","🍲","🫕","🥣","🥗","🍿","🧈","🍱","🍘","🍙","🍚","🍛","🍜","🍝","🍞","🥐","🎂","🍰","🧁","🥧","🍫","🍬","🍭","🍮","🍯","🍼","🥛","☕","🫖","🍵","🍶","🍾","🍷","🍸","🍹","🍺","🍻","🥂","🥃"],
  },
];

export default function EmojiPicker({ onSelect, onClose }: { onSelect: (emoji: string) => void; onClose: () => void }) {
  const [cat, setCat] = useState(0);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const emojis = search
    ? CATEGORIES.flatMap((c) => c.emojis)
    : CATEGORIES[cat].emojis;

  return (
    <div ref={ref} className="absolute bottom-full left-0 mb-2 w-80 max-h-72 bg-white rounded-xl shadow-lg border border-border flex flex-col z-50">
      <div className="px-2 pt-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search emoji..."
          className="w-full px-3 py-1.5 text-sm rounded-lg bg-gray-50 focus:outline-none focus:ring-1 focus:ring-primary"
          autoFocus
        />
      </div>
      {!search && (
        <div className="flex gap-1 px-2 pt-1.5 pb-1 overflow-x-auto">
          {CATEGORIES.map((c, i) => (
            <button
              key={c.label}
              onClick={() => setCat(i)}
              className={`text-xs px-2 py-1 rounded-full whitespace-nowrap ${i === cat ? "bg-primary/10 text-primary font-medium" : "text-muted hover:bg-gray-100"}`}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-2 pb-2 grid grid-cols-8 gap-0.5">
        {emojis.map((e, i) => (
          <button
            key={`${e}-${i}`}
            onClick={() => { onSelect(e); onClose(); }}
            className="w-8 h-8 flex items-center justify-center text-xl hover:bg-gray-100 rounded"
          >
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}

export const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
