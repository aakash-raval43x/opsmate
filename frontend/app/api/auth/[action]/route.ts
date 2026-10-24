// frontend/app/api/auth/[action]/route.ts
// Browser-facing login/register endpoints for OpsMate's web UI.
//
// The browser stays on a single origin (Next.js at :3001 in Docker). This
// route forwards to the Express backend at :5000 and passes the incoming
// Authorization header straight through, so the Bearer tokens issued by the
// backend's auth.js are the only credentials the UI ever handles.
//
// In Docker, Caddy forwards /api/* to the Next port (5173), so the flow is
// browser → Next → Express, never touching the user's code for network hops.

import type { NextRequest } from "next/server";

const BACKEND_URL =
  (process.env.BACKEND_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    "http://localhost:5000")
    .replace(/\/$/, "");

// Only the four identity actions are ever proxied.
const AUTH_ACTIONS = ["register", "login", "me", "logout"] as const;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authActionFromUrl(url: URL) {
  const segments = url.pathname.split("/").filter(Boolean);
  return segments[segments.length - 1] as (typeof AUTH_ACTIONS)[number];
}

async function forwardAuth(req: NextRequest, action: (typeof AUTH_ACTIONS)[number]) {
  if (!AUTH_ACTIONS.includes(action)) {
    return Response.json({ ok: false, error: "Unknown auth action." }, { status: 404 });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Pass every credential the browser sent through to the backend unchanged.
  const authHeader = req.headers.get("authorization");
  if (authHeader) {
    headers.Authorization = authHeader;
  }

  const method = req.method;
  let body: string | undefined;

  if (method === "POST") {
    body = await req.text();
    if (body) {
      try {
        // Forward the raw body so JSON remains a JSON body for the backend.
        void JSON.parse(body);
      } catch {
        // Not JSON (expected for /me which is GET-only, tolerated for POST).
      }
    }
  }

  const res = await fetch(`${BACKEND_URL}/api/auth/${action}`, {
    method,
    headers,
    body: body ?? undefined,
  });

  const forwardHeaders: HeadersInit = {
    "Content-Type": "application/json",
  };
  for (const [key, value] of res.headers.entries()) {
    if (!["transfer-encoding", "connection"].includes(key.toLowerCase())) {
      forwardHeaders[key] = value;
    }
  }

  return new Response(res.body ?? "", {
    status: res.status,
    headers: forwardHeaders,
  });
}

export async function POST(req: NextRequest) {
  return forwardAuth(req, authActionFromUrl(new URL(req.url)));
}

export async function GET(req: NextRequest) {
  return forwardAuth(req, authActionFromUrl(new URL(req.url)));
}

export async function DELETE(req: NextRequest) {
  return forwardAuth(req, authActionFromUrl(new URL(req.url)));
}
