"use client";

import { logout } from "@/lib/api";

export default function LogoutButton({ className = "" }: { className?: string }) {
  return (
    <button
      onClick={() => {
        if (confirm("Sign out?")) logout();
      }}
      title="Sign out"
      className={`text-sm px-3 py-1.5 rounded-full hover:bg-white/15 ${className}`}
    >
      Logout
    </button>
  );
}
