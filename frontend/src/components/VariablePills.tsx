"use client";

import { useState } from "react";

interface Props {
  fields: string[];
  onInsert: (name: string) => void;
}

const COLLAPSED_COUNT = 8;

export default function VariablePills({ fields, onInsert }: Props) {
  const [showAll, setShowAll] = useState(false);

  if (!fields.length) return null;

  const visible = showAll ? fields : fields.slice(0, COLLAPSED_COUNT);
  const hidden = fields.length - visible.length;

  return (
    <div className="flex flex-wrap items-center gap-1 mt-1.5">
      <span className="text-[10px] uppercase tracking-wider text-muted font-medium mr-0.5">Insert:</span>
      {visible.map((f) => (
        <button
          key={f}
          type="button"
          onClick={() => onInsert(f)}
          title={`Insert {{${f}}} at cursor`}
          className="px-2 py-0.5 text-xs rounded-full border border-border bg-gray-50 hover:bg-primary/10 hover:border-primary/40 hover:text-primary transition-colors font-mono"
        >
          {`{{${f}}}`}
        </button>
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="px-1.5 py-0.5 text-xs text-primary hover:underline"
        >
          +{hidden} more
        </button>
      )}
      {showAll && fields.length > COLLAPSED_COUNT && (
        <button
          type="button"
          onClick={() => setShowAll(false)}
          className="px-1.5 py-0.5 text-xs text-muted hover:underline"
        >
          less
        </button>
      )}
    </div>
  );
}
