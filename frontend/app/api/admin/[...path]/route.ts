// frontend/app/api/admin/[...path]/route.ts
// Catch-all proxy: browser (single origin :3001) → Express backend /api/admin/*.
// Forwards method, JSON body and the Authorization header unchanged; the
// backend verifies the session and enforces admin-only access (fail closed),
// so this proxy carries no authorization logic of its own.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BACKEND_URL = (
  process.env.BACKEND_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "http://localhost:5000"
).replace(/\/+$/, "");

async function forward(
  request: Request,
  pathSegments: string[],
  searchParams: string
): Promise<Response> {
  const authorization = request.headers.get("authorization");

  const headers: Record<string, string> = {};
  if (authorization) headers.Authorization = authorization;
  if (request.method !== "GET" && request.method !== "DELETE") {
    headers["Content-Type"] = "application/json";
  }

  let body: string | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.text().catch(() => undefined);
  }

  let backend: Response;
  try {
    backend = await fetch(
      `${BACKEND_URL}/api/admin/${pathSegments.map(encodeURIComponent).join("/")}${searchParams}`,
      {
        method: request.method,
        headers,
        body,
        cache: "no-store",
      }
    );
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: `OpsMate backend unreachable at ${BACKEND_URL}.`,
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 503 }
    );
  }

  const data = await backend.text().catch(() => "");
  const out = new Headers({ "Content-Type": "application/json" });

  return new Response(data, { status: backend.status, headers: out });
}

type Ctx = { params: Promise<{ path?: string[] }> };

async function handler(request: Request, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  const { search } = new URL(request.url);
  return forward(request, path ?? [], search);
}

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
