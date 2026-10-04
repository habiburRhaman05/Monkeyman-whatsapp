import type { NextConfig } from "next";

// Where the FastAPI backend listens, as seen from the machine running the Next.js server.
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";

const nextConfig: NextConfig = {
  // The browser only talks to this server; /api/* is forwarded to the backend.
  // This avoids cross-origin calls, which GitHub Codespaces private ports block.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${BACKEND_URL}/:path*` }];
  },
  // Allow the dev server to be opened through a Codespaces forwarded address.
  allowedDevOrigins: ["*.app.github.dev"],
};

export default nextConfig;
