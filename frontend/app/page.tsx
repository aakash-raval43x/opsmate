"use client";

import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  StreamMarkerParser,
  type StreamMeta,
  type StreamParseResult,
  type TraceStep,
} from "@/lib/stream-parser";

// ============================================================
// Types
// ============================================================

interface UsageStats {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface CacheInfo {
  layer: string;
  provider: string;
  hit: boolean;
  tool: string | null;
  embeddingStatus: string | null;
  semanticStatus: string | null;
  similarity: number | null;
}

interface LatencyInfo {
  firstTokenMs: number | null;
  serverMs: number | null;
  totalMs: number;
}

interface ErrorInfo {
  icon: string;
  title: string;
  body: string;
}

interface ActiveRequest {
  id: number;
  controller: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  cancelled: boolean;
}

const MAX_HISTORY_MESSAGES = 3;
const MAX_HISTORY_ITEMS = MAX_HISTORY_MESSAGES * 2;

const LAYER_LABELS: Record<string, string> = {
  L1_MEMORY: "In-memory cache",
  L2_POSTGRES: "PostgreSQL exact match",
  L2_SEMANTIC: "PostgreSQL semantic match",
  COALESCED: "Shared in-flight request",
  MISS: "Live LLM response",
  BYPASS: "Cache bypassed",
  BYPASS_ORDER: "Direct order lookup",
  GREETING: "Greeting handler",
  OUT_OF_SCOPE: "Out-of-scope handler",
};

const PROVIDER_LABELS: Record<string, string> = {
  ollama: "Ollama",
  postgres: "PostgreSQL",
  cache: "Cache",
  "scope-gate": "Scope gate",
};

const HIT_LAYERS = new Set(["L1_MEMORY", "L2_POSTGRES", "L2_SEMANTIC"]);

const isCacheHit = (layer: string) => HIT_LAYERS.has(layer);

const cacheLayerLabel = (layer: string) => LAYER_LABELS[layer] ?? layer;

const cacheProviderLabel = (provider: string) =>
  PROVIDER_LABELS[provider] ?? provider;

function cacheOutcome(layer: string): string {
  if (isCacheHit(layer)) return "CACHE HIT";
  if (layer === "COALESCED") return "SHARED REQUEST";
  if (layer === "BYPASS_ORDER") return "ORDER LOOKUP";
  if (layer === "GREETING") return "GREETING";
  if (layer === "OUT_OF_SCOPE") return "OUT OF SCOPE";
  if (layer === "BYPASS") return "CACHE BYPASSED";
  return "CACHE MISS";
}

function embeddingStatusDisplay(
  status: string | null
): { icon: string; text: string } | null {
  switch (status) {
    case "HIT":
      return { icon: "🧬", text: "Embedding generated" };
    case "MISS":
      return { icon: "🧬❌", text: "Embedding failed" };
    case "SKIPPED":
      return { icon: "🧬⏭", text: "Embedding skipped" };
    case "SHARED":
      return { icon: "🧬🔗", text: "Embedding shared" };
    default:
      return null;
  }
}

function semanticStatusDisplay(
  status: string | null,
  similarity: number | null
): { icon: string; text: string } | null {
  switch (status) {
    case "HIT":
      return {
        icon: "🎯",
        text:
          similarity !== null
            ? `Semantic HIT (${Math.round(similarity * 100)}% similarity)`
            : "Semantic cache HIT",
      };
    case "MISS":
      return { icon: "🔍", text: "Semantic cache MISS" };
    case "SKIPPED":
      return { icon: "⏭", text: "Semantic cache skipped" };
    case "NOT_CHECKED":
      return { icon: "➖", text: "Semantic cache not checked" };
    case "SHARED":
      return { icon: "🔗", text: "Semantic cache shared" };
    default:
      return null;
  }
}

function latencyText(latency: LatencyInfo): string {
  if (latency.firstTokenMs !== null) {
    return `First token ${latency.firstTokenMs}ms · total ${latency.totalMs}ms`;
  }

  if (latency.serverMs !== null) {
    return `Server ${latency.serverMs}ms · total ${latency.totalMs}ms`;
  }

  return `Total ${latency.totalMs}ms`;
}

function parseServerTiming(header: string | null): Record<string, number> {
  const out: Record<string, number> = {};

  if (!header) return out;

  for (const part of header.split(",")) {
    const match = part.trim().match(/^([\w-]+);dur=([\d.]+)$/);

    if (match) {
      out[match[1]] = Number(match[2]);
    }
  }

  return out;
}

// ============================================================
// Pipeline trace labels
// ============================================================

const TRACE_STAGE_LABELS: Record<string, string> = {
  understand: "understand",
  scope: "scope",
  route: "route",
  cache: "cache",
  tool: "tool",
  answer: "answer",
  done: "done",
  error: "error",
};

// ============================================================
// Error handling
// ============================================================

function extractErrorMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw);

    if (typeof parsed === "string") return parsed;

    return parsed?.message || parsed?.error || raw;
  } catch {
    return raw;
  }
}

const CREDIT_ERROR_RE = /credit|quota|billing|insufficient/i;
const PROVIDER_LIST_RE = /^AI Service Unavailable\s*/i;

function creditError(): ErrorInfo {
  return {
    icon: "💳",
    title: "AI Credit Limit Reached",
    body: "You've reached your AI credit limit. Add credits to the AI provider account or switch to a provider with available credits, then try again.",
  };
}

function parseErrorInfo(raw: string): ErrorInfo {
  const msg = raw.toLowerCase();

  if (CREDIT_ERROR_RE.test(msg)) {
    return creditError();
  }

  if (PROVIDER_LIST_RE.test(raw)) {
    const reasons = raw
      .replace(PROVIDER_LIST_RE, "")
      .replace(/Please try again later\.?\s*$/i, "")
      .trim();

    const bullets = reasons
      .split("\n")
      .filter((line) => line.trim().startsWith("•"))
      .map((line) => line.replace(/^[\s•]+/, "").trim());

    if (
      bullets.length > 0 &&
      bullets.every((item) => CREDIT_ERROR_RE.test(item))
    ) {
      return creditError();
    }

    return {
      icon: "⛔",
      title: "All AI Providers Failed",
      body: bullets.length > 0 ? bullets.join("\n") : reasons,
    };
  }

  if (
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("429")
  ) {
    return {
      icon: "⏳",
      title: "Too Many Requests",
      body: "The AI service is receiving too many requests. Wait a moment, then try again.",
    };
  }

  if (
    msg.includes("api key") ||
    msg.includes("authentication") ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden") ||
    msg.includes("401") ||
    msg.includes("403")
  ) {
    return {
      icon: "🔑",
      title: "Authentication Error",
      body: "The AI service rejected the API key. Check the key configuration, then try again.",
    };
  }

  if (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("etimedout")
  ) {
    return {
      icon: "⌛",
      title: "Request Timed Out",
      body: "The AI took too long to respond. Check your connection and try again.",
    };
  }

  if (
    msg.includes("network") ||
    msg.includes("fetch") ||
    msg.includes("econnrefused") ||
    msg.includes("failed to fetch")
  ) {
    return {
      icon: "📡",
      title: "Network Error",
      body: "Could not reach the assistant service. Check that the backend is running and your connection is stable.",
    };
  }

  if (
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("service unavailable") ||
    msg.includes("temporarily unavailable") ||
    msg.includes("overloaded") ||
    msg.includes("unavailable")
  ) {
    return {
      icon: "🔧",
      title: "Service Temporarily Unavailable",
      body: "The AI service is having issues right now. Try again in a few minutes.",
    };
  }

  if (
    msg.includes("please type a question") ||
    msg.includes("please enter a question")
  ) {
    return {
      icon: "✏️",
      title: "Empty Question",
      body: "Type a question first, then press Ask.",
    };
  }

  return {
    icon: "⚠️",
    title: "Something Went Wrong",
    body: raw || "An unexpected error occurred. Please try again.",
  };
}

// ============================================================
// Main component
// ============================================================

export default function Home() {
  const [mounted, setMounted] = useState(false);
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [model, setModel] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [wsStatus, setWsStatus] = useState("Connecting WebSocket...");
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [identity, setIdentity] = useState<{
    name: string;
    email: string;
    role: string;
  } | null>(null);
  const [cacheInfo, setCacheInfo] = useState<CacheInfo | null>(null);
  const [latency, setLatency] = useState<LatencyInfo | null>(null);
  const [currentQuestion, setCurrentQuestion] = useState("");
  const [requestNumber, setRequestNumber] = useState<number | null>(null);
  const [trace, setTrace] = useState<TraceStep[]>([]);

  const [currentUsage, setCurrentUsage] = useState<UsageStats | null>(null);

  const [totalUsage, setTotalUsage] = useState<UsageStats>({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  });

  const activeRequestRef = useRef<ActiveRequest | null>(null);
  const requestIdRef = useRef(0);
  const streamedAnswerRef = useRef("");
  const animationFrameRef = useRef<number | null>(null);
  const streamMetaRef = useRef<StreamMeta | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setMounted(true), 20);

    return () => window.clearTimeout(timer);
  }, []);

  function updateIdentity(user: { name: string; email: string; role?: string }) {
    setIdentity({
      name: user.name,
      email: user.email,
      role: user.role ?? "user",
    });
  }

  // Identity state now carries the verified role from /api/auth/me — admin
  // users additionally get an "Admin panel" link in the header.

  function getStoredToken(): string | null {
    if (typeof window === "undefined") return null;
    // sessionStorage is the canonical home (the login page writes there), with
    // a localStorage fallback for tokens saved by older builds — migrated and
    // cleaned up on the fly.
    const token =
      window.sessionStorage.getItem("opsmate_auth_token") ||
      window.localStorage.getItem("opsmate_auth_token");
    if (token) {
      window.sessionStorage.setItem("opsmate_auth_token", token);
      window.localStorage.removeItem("opsmate_auth_token");
    }
    return token;
  }

  async function signOut() {
    const token = getStoredToken();
    try {
      if (token) {
        await fetch("/api/auth/logout", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    } catch {
      // Logout is best-effort: the session is cleared below regardless.
    }
    window.sessionStorage.removeItem("opsmate_auth_token");
    window.localStorage.removeItem("opsmate_auth_token");
    setIdentity(null);
    window.location.href = "/";
  }

  // ============================================================
  // Logged-in identity (fetched from the backend only)
  // ============================================================

  useEffect(() => {
    let alive = true;

    async function fetchIdentity() {
      const token = getStoredToken();

      if (!token) {
        setIdentity(null);
        return;
      }

      try {
        const res = await fetch("/api/auth/me", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });

        if (!res.ok) throw new Error("unauthorized");

        const data = await res.json();

        if (!alive) return;

        updateIdentity(data.user)
      } catch {
        if (alive) setIdentity(null);
      }
    }

    fetchIdentity();

    return () => {
      alive = false;
    };
  }, []);

  function openAuthModal() {
    const params = new URLSearchParams(window.location.search);
    const next = params.get("next") || "/";
    window.location.href = `/login?next=${encodeURIComponent(next)}`;
  }

  function isCurrentRequest(request: ActiveRequest): boolean {
    return (
      activeRequestRef.current === request &&
      !request.cancelled &&
      !request.controller.signal.aborted
    );
  }

  function cancelAnswerFrame() {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }

  function scheduleAnswerUpdate(request: ActiveRequest) {
    if (!isCurrentRequest(request)) return;
    if (animationFrameRef.current !== null) return;

    animationFrameRef.current = requestAnimationFrame(() => {
      animationFrameRef.current = null;

      if (isCurrentRequest(request)) {
        setAnswer(streamedAnswerRef.current);
      }
    });
  }

  function flushAnswerUpdate(request: ActiveRequest) {
    if (!isCurrentRequest(request)) return;

    cancelAnswerFrame();
    setAnswer(streamedAnswerRef.current);
  }

  // ============================================================
  // Stop request
  // ============================================================

  function cancelActiveRequest(preservePartialAnswer: boolean) {
    const request = activeRequestRef.current;

    if (!request) return;

    request.cancelled = true;
    activeRequestRef.current = null;

    console.log(`[Q-${request.id}] CANCEL | User stopped request`);

    request.controller.abort();

    if (request.reader) {
      void request.reader.cancel().catch(() => { });
    }

    cancelAnswerFrame();

    if (preservePartialAnswer) {
      setAnswer(streamedAnswerRef.current);
    } else {
      streamedAnswerRef.current = "";
      setAnswer("");
    }

    setLoading(false);
  }

  // ============================================================
  // Cleanup
  // ============================================================

  useEffect(() => {
    return () => {
      const request = activeRequestRef.current;

      if (request) {
        request.cancelled = true;
        activeRequestRef.current = null;
        request.controller.abort();

        if (request.reader) {
          void request.reader.cancel().catch(() => { });
        }
      }

      cancelAnswerFrame();
    };
  }, []);

  // ============================================================
  // WebSocket status
  // ============================================================

  useEffect(() => {
    let ws: WebSocket | null = null;

    try {
      const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:5001/ws";

      ws = new WebSocket(wsUrl);

      ws.onopen = () => setWsStatus("WebSocket Connected");

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === "status") {
            console.log(`[WS] ${data.message}`);
          }
        } catch {
          // Ignore invalid WebSocket messages.
        }
      };

      ws.onerror = () => setWsStatus("WebSocket Standby");
      ws.onclose = () => setWsStatus("WebSocket Standby");
    } catch {
      queueMicrotask(() => setWsStatus("WebSocket Standby"));
    }

    return () => ws?.close();
  }, []);

  // ============================================================
  // Main request
  // ============================================================

  async function runSearch(e?: FormEvent) {
    e?.preventDefault();

    const q = query.trim();

    if (!q) {
      setError("Please enter a question first.");
      return;
    }

    if (activeRequestRef.current) return;

    const request: ActiveRequest = {
      id: ++requestIdRef.current,
      controller: new AbortController(),
      reader: null,
      cancelled: false,
    };

    activeRequestRef.current = request;

    setRequestNumber(request.id);
    setCurrentQuestion(q);
    setLoading(true);
    setError("");
    setAnswer("");
    setModel("");
    setCacheInfo(null);
    setLatency(null);
    setCurrentUsage(null);
    setTrace([]);

    streamedAnswerRef.current = "";
    streamMetaRef.current = null;

    const startedAt = performance.now();
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    console.log(`[Q-${request.id}] START | ${q}`);

    try {
      const requestHistory = history.slice(-MAX_HISTORY_ITEMS);

      const res = await fetch("/api/assist", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(getStoredToken()
            ? { Authorization: `Bearer ${getStoredToken()}` }
            : {}),
        },
        body: JSON.stringify({
          query: q,
          history: requestHistory,
        }),
        signal: request.controller.signal,
      });

      if (!isCurrentRequest(request)) return;

      if (!res.ok || !res.body) {
        const raw = await res.text().catch(() => "");

        if (!isCurrentRequest(request)) return;

        throw new Error(
          extractErrorMessage(raw) || `Request failed (${res.status})`
        );
      }

      const providerName = res.headers.get("x-provider") || "";
      const providerModel = res.headers.get("x-model") || "";
      const headerLayer = res.headers.get("x-cache") || "MISS";
      const toolName = res.headers.get("x-tool");
      const timing = parseServerTiming(res.headers.get("server-timing"));

      const embeddingStatus = res.headers.get("x-embedding-cache");
      const semanticStatus = res.headers.get("x-semantic-cache");
      const similarityHeader = res.headers.get("x-similarity");

      setModel(
        providerModel ? `${providerName} · ${providerModel}` : providerName
      );

      setCacheInfo({
        layer: headerLayer,
        provider: providerName,
        hit: isCacheHit(headerLayer),
        tool: toolName,
        embeddingStatus,
        semanticStatus,
        similarity:
          similarityHeader !== null ? Number(similarityHeader) : null,
      });

      console.log(
        `[Q-${request.id}] CACHE | ${cacheOutcome(headerLayer)} | ${headerLayer} | ${cacheLayerLabel(headerLayer)}`
      );

      reader = res.body.getReader();
      request.reader = reader;

      const decoder = new TextDecoder();
      const parser = new StreamMarkerParser();

      const appendAnswerText = (text: string) => {
        if (!text) return;

        streamedAnswerRef.current += text;
        scheduleAnswerUpdate(request);
      };

      const applyParsed = (parsed: StreamParseResult) => {
        appendAnswerText(parsed.text);

        if (parsed.traces.length > 0) {
          setTrace((prev) => [...prev, ...parsed.traces]);
        }
      };

      while (true) {
        const { done, value } = await reader.read();

        if (!isCurrentRequest(request)) return;
        if (done) break;

        applyParsed(parser.push(decoder.decode(value, { stream: true })));
      }

      if (!isCurrentRequest(request)) return;

      applyParsed(parser.push(decoder.decode()));

      const ending = parser.finish();

      if (!isCurrentRequest(request)) return;

      if (ending.error !== null) {
        cancelAnswerFrame();

        streamedAnswerRef.current = "";

        setAnswer("");
        setModel("");
        setCacheInfo(null);
        setLatency(null);
        setCurrentUsage(null);
        setError(ending.error);

        console.error(`[Q-${request.id}] ERROR | ${ending.error}`);

        return;
      }

      if (ending.meta) {
        streamMetaRef.current = ending.meta;
      }

      appendAnswerText(ending.text);

      if (!isCurrentRequest(request)) return;

      flushAnswerUpdate(request);

      if (streamMetaRef.current) {
        const meta = streamMetaRef.current;
        const metaLayer = meta.layer || headerLayer;

        setCacheInfo((prev) =>
          prev
            ? {
              ...prev,
              layer: metaLayer,
              hit: isCacheHit(metaLayer),
              provider: meta.provider || prev.provider,
              tool: meta.tool ?? prev.tool,
              embeddingStatus: meta.embeddingStatus ?? prev.embeddingStatus,
              semanticStatus: meta.semanticStatus ?? prev.semanticStatus,
              similarity: meta.similarity ?? prev.similarity,
            }
            : prev
        );

        if (meta.provider || meta.model) {
          setModel([meta.provider, meta.model].filter(Boolean).join(" · "));
        }
      }

      const finalAnswer = streamedAnswerRef.current;
      const totalMs = Math.round(performance.now() - startedAt);
      const finalLayer = streamMetaRef.current?.layer || headerLayer;

      setLatency({
        firstTokenMs: timing["first-token"] ?? null,
        serverMs: timing["total"] ?? streamMetaRef.current?.serverMs ?? null,
        totalMs,
      });

      console.log(
        `[Q-${request.id}] RESULT | ${cacheOutcome(finalLayer)} | ${finalLayer} | ${cacheProviderLabel(providerName)} | ${totalMs}ms`
      );

      const historyCharacters = requestHistory.reduce(
        (total, message) => total + message.content.length,
        0
      );

      const promptEstimate = Math.ceil((q.length + historyCharacters) / 4);

      const completionEstimate = Math.ceil(finalAnswer.length / 4);

      const usage: UsageStats = {
        promptTokens: promptEstimate,
        completionTokens: completionEstimate,
        totalTokens: promptEstimate + completionEstimate,
      };

      if (!isCurrentRequest(request)) return;

      setCurrentUsage(usage);

      setTotalUsage((prev) => ({
        promptTokens: prev.promptTokens + usage.promptTokens,
        completionTokens: prev.completionTokens + usage.completionTokens,
        totalTokens: prev.totalTokens + usage.totalTokens,
      }));

      const completedTurn: ChatMessage[] = [
        { role: "user", content: q },
        {
          role: "assistant",
          content: finalAnswer || "(empty response)",
        },
      ];

      if (!isCurrentRequest(request)) return;

      setHistory((prev) => [...prev, ...completedTurn].slice(-MAX_HISTORY_ITEMS));
    } catch (err) {
      if (!isCurrentRequest(request)) {
        console.log(`[Q-${request.id}] CANCELLED | Ignored stale request`);
        return;
      }

      if (
        request.controller.signal.aborted ||
        (err instanceof Error && err.name === "AbortError")
      ) {
        console.log(`[Q-${request.id}] CANCELLED | Request aborted`);
        return;
      }

      const message = err instanceof Error ? err.message : "Something went wrong";

      setError(message);
      console.error(`[Q-${request.id}] ERROR | ${message}`);
    } finally {
      if (reader) {
        try {
          reader.releaseLock();
        } catch {
          // Reader may still have a pending read.
        }
      }

      if (activeRequestRef.current === request) {
        activeRequestRef.current = null;
        setLoading(false);
      }
    }
  }

  // ============================================================
  // Reset and keyboard handlers
  // ============================================================

  function stopResponse(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    cancelActiveRequest(true);
  }

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;

    event.preventDefault();
    void runSearch();
  }

  function resetSession() {
    cancelActiveRequest(false);
    cancelAnswerFrame();

    streamedAnswerRef.current = "";
    streamMetaRef.current = null;

    setHistory([]);
    setCurrentUsage(null);

    setTotalUsage({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });

    setCacheInfo(null);
    setLatency(null);
    setAnswer("");
    setQuery("");
    setError("");
    setModel("");
    setCurrentQuestion("");
    setRequestNumber(null);
    setTrace([]);
  }

  // ============================================================
  // UI values
  // ============================================================

  const embeddingBadge = cacheInfo
    ? embeddingStatusDisplay(cacheInfo.embeddingStatus)
    : null;

  const semanticBadge = cacheInfo
    ? semanticStatusDisplay(cacheInfo.semanticStatus, cacheInfo.similarity)
    : null;

  const isShared = cacheInfo?.layer === "COALESCED";

  const isBypass =
    cacheInfo?.layer === "BYPASS_ORDER" ||
    cacheInfo?.layer === "BYPASS" ||
    cacheInfo?.layer === "GREETING" ||
    cacheInfo?.layer === "OUT_OF_SCOPE";

  // ============================================================
  // Cache badge (same look as the login page's message bar)
  // ============================================================

  const cacheBadgeClass =
    cacheInfo && isCacheHit(cacheInfo.layer)
      ? "hit"
      : cacheInfo && (isShared || isBypass)
        ? "stats"
        : "miss";

  // This is what was missing — the text shown inside the cache badge.
  const visibleCacheStatus = loading
    ? "PENDING…"
    : cacheInfo
      ? cacheOutcome(cacheInfo.layer)
      : "NO REQUEST YET";

  // ============================================================
  // Branded header + main UI
  // ============================================================

  return (
    <main
      className={`page transition-all duration-700 ease-out ${mounted ? "animate-in fade-in slide-in-from-bottom-6" : "opacity-0"
        }`}
    >
      <div className="shell">
        <header className="header">
          <div className="header-top">
            <div className="brand-group">
              <p className="brand-eyebrow">OPSMATE</p>

              <div className="brand-title-row">
                <h1 className="brand">OpsMate</h1>

                <span
                  className={`ws-badge ${wsStatus.includes("Connected") ? "connected" : ""
                    }`}
                >
                  ● {wsStatus}
                </span>
              </div>
            </div>

            {identity && (
              <span className="identity animated-in">
                <span className="identity-label">Logged in as</span>
                <span className="identity-name">{identity.name}</span>
                <span className="identity-email">{identity.email}</span>
                <span
                  className={`pill ${identity.role === "admin" ? "admin" : "user"}`}
                >
                  {identity.role === "admin" ? "Admin" : "User"}
                </span>
                {identity.role === "admin" && (
                  <a
                    href="/admin"
                    className="identity-admin-link"
                  >
                    ⚙ Admin panel
                  </a>
                )}
                <button
                  type="button"
                  className="identity-signout"
                  onClick={() => void signOut()}
                >
                  Sign out
                </button>
              </span>
            )}

            {!identity && (
              <span className="identity identity-empty animated-in">
                No logged-in user
              </span>
            )}

            {!identity && (
              <button type="button" className="auth-open-btn" onClick={openAuthModal}>
                <span className="auth-open-btn-icon">⟶</span>
                <span>Sign in / create account</span>
              </button>
            )}

            {(history.length > 0 || loading) && (
              <button type="button" onClick={resetSession} className="reset-btn">
                Reset Context
              </button>
            )}
          </div>

          <p className="sub">
            Ask a question. Cached answers return quickly; cache misses are
            generated by the model.
          </p>


        </header>

        {/* Search form */}
        <form className="search" onSubmit={runSearch}>
          <label htmlFor="q" className="sr-only">
            Search
          </label>

          <input
            id="q"
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (error) setError("");
            }}
            placeholder="Ask the model something…"
            autoComplete="off"
            disabled={loading}
            onKeyDown={handleInputKeyDown}
          />

          {loading ? (
            <button
              type="button"
              onClick={stopResponse}
              className="stop-btn"
              aria-label="Stop generating response"
            >
              ■ Stop
            </button>
          ) : (
            <button type="submit" className="ask-btn">
              Ask
            </button>
          )}
        </form>

        {/* AI response */}
        <section
          className="response-panel"
          aria-live="polite"
          aria-label="AI response"
        >
          <div className="response-panel-header">
            <div>
              <h2>AI Response</h2>

              {requestNumber !== null && (
                <p className="response-question">
                  Q-{requestNumber}: {currentQuestion}
                </p>
              )}
            </div>

            <span
              className={`cache-badge ${cacheBadgeClass} ${loading ? "pending-pulse" : ""
                }`}
            >
              {visibleCacheStatus}
            </span>
          </div>

          <div className="response-cache-info">
            <span>
              <strong>Layer:</strong>{" "}
              {cacheInfo ? cacheLayerLabel(cacheInfo.layer) : "Not determined yet"}
            </span>

            {model && (
              <span>
                <strong>Provider:</strong> {model}
              </span>
            )}

            {latency && (
              <span>
                <strong>Time:</strong> {latencyText(latency)}
              </span>
            )}

            {cacheInfo?.tool && (
              <span>
                <strong>Tool:</strong> {cacheInfo.tool}
              </span>
            )}
          </div>

          {loading && (
            <div className="response-loading">
              <span className="loading-spinner" />
              <span>
                {answer ? "Generating response…" : "Waiting for the first token…"}
              </span>
            </div>
          )}

          <div className="response-body">
            {answer ? (
              <pre>{answer}</pre>
            ) : loading ? (
              <p className="response-placeholder">
                The answer will appear here while it streams.
              </p>
            ) : error ? (
              <p className="response-placeholder">
                The response could not be completed. See the error below.
              </p>
            ) : (
              <p className="response-placeholder">Your answer will appear here.</p>
            )}
          </div>

          {cacheInfo && (
            <div className="response-details">
              {embeddingBadge && (
                <span className="meta-chip">
                  {embeddingBadge.icon} {embeddingBadge.text}
                </span>
              )}

              {semanticBadge && (
                <span className="meta-chip">
                  {semanticBadge.icon} {semanticBadge.text}
                </span>
              )}

              {cacheInfo.layer === "L1_MEMORY" && (
                <p className="response-explanation">
                  This answer came from the in-memory cache. The LLM did not need
                  to generate it again.
                </p>
              )}

              {cacheInfo.layer === "L2_POSTGRES" && (
                <p className="response-explanation">
                  An exact match was found in PostgreSQL cache.
                </p>
              )}

              {cacheInfo.layer === "L2_SEMANTIC" && (
                <p className="response-explanation">
                  A semantically similar cached answer was reused.
                </p>
              )}

              {cacheInfo.layer === "MISS" && (
                <p className="response-explanation">
                  No usable cache answer was found; the model generated a new
                  response.
                </p>
              )}

              {cacheInfo.layer === "BYPASS_ORDER" && (
                <p className="response-explanation">
                  Order details were looked up directly in PostgreSQL. This is
                  not a cache hit.
                </p>
              )}

              {isShared && (
                <p className="response-explanation">
                  This request shared work with another identical request; it is
                  not a stored-cache hit.
                </p>
              )}

              {isBypass && cacheInfo.layer !== "BYPASS_ORDER" && (
                <p className="response-explanation">
                  This request bypassed the regular cache path.
                </p>
              )}
            </div>
          )}
        </section>

        {/* Live pipeline trace */}
        {trace.length > 0 && (
          <section
            className="trace-panel"
            aria-live="polite"
            aria-label="Pipeline trace"
          >
            <div className="trace-header">
              <h2>🧭 Pipeline trace</h2>

              <span className={`trace-state ${loading ? "live" : "done"}`}>
                {loading ? "● live" : "● complete"}
              </span>
            </div>

            <ol className="trace-list">
              {trace.map((step, idx) => (
                <li
                  key={`trace-${idx}-${step.n ?? 0}-${step.stage}`}
                  className={`trace-step ${step.stage} ${step.status}`}
                >
                  <span className="trace-dot" aria-hidden="true" />

                  <span className="trace-stage">
                    {TRACE_STAGE_LABELS[step.stage] ?? step.stage}
                  </span>

                  <span className="trace-text">
                    <span className="trace-title">{step.title}</span>

                    {step.detail && (
                      <span className="trace-detail">{step.detail}</span>
                    )}
                  </span>

                  <span className="trace-ms">
                    {step.ms > 0 ? `${step.ms}ms` : ""}
                  </span>
                </li>
              ))}

              {loading && (
                <li className="trace-step pending">
                  <span className="trace-dot" aria-hidden="true" />
                  <span className="trace-stage">…</span>
                  <span className="trace-text">
                    <span className="trace-title">Working…</span>
                  </span>
                  <span className="trace-ms" />
                </li>
              )}
            </ol>
          </section>
        )}

        {/* Error */}
        {error &&
          (() => {
            const { icon, title, body } = parseErrorInfo(error);

            return (
              <div className="error-card" role="alert" aria-live="assertive">
                <div className="error-card-header">
                  <span className="error-card-icon" aria-hidden="true">
                    {icon}
                  </span>

                  <p className="error-card-title">{title}</p>
                </div>

                <p className="error-card-body">{body}</p>

                <button
                  type="button"
                  className="error-card-retry"
                  onClick={() => void runSearch()}
                >
                  🔄 Try Again
                </button>
              </div>
            );
          })()}

        {/* Context usage */}
        {currentUsage && (
          <section className="context-usage" aria-label="Context Usage">
            <h2>📊 Context Usage</h2>

            <div className="usage-grid">
              <div className="usage-card current">
                <div className="card-header">
                  <span className="icon">⚡</span>
                  <h3>Current Request Context</h3>
                </div>

                <p className="description">
                  Estimated tokens for the latest request
                </p>

                <div className="token-metrics">
                  <div className="metric">
                    <span className="label">Prompt (Input):</span>
                    <span className="value">
                      {currentUsage.promptTokens.toLocaleString()} tokens
                    </span>
                  </div>

                  <div className="metric">
                    <span className="label">Response (Output):</span>
                    <span className="value">
                      {currentUsage.completionTokens.toLocaleString()} tokens
                    </span>
                  </div>

                  <div className="metric total">
                    <span className="label">Current Request Total:</span>
                    <span className="value">
                      {currentUsage.totalTokens.toLocaleString()} tokens
                    </span>
                  </div>
                </div>
              </div>

              <div className="usage-card total">
                <div className="card-header">
                  <span className="icon">📈</span>
                  <h3>Total Context (Accumulated)</h3>
                </div>

                <p className="description">
                  Estimated tokens across requests in this session
                </p>

                <div className="token-metrics">
                  <div className="metric">
                    <span className="label">Total Prompt Tokens:</span>
                    <span className="value">
                      {totalUsage.promptTokens.toLocaleString()} tokens
                    </span>
                  </div>

                  <div className="metric">
                    <span className="label">Total Response Tokens:</span>
                    <span className="value">
                      {totalUsage.completionTokens.toLocaleString()} tokens
                    </span>
                  </div>

                  <div className="metric total">
                    <span className="label">Total Accumulated Context:</span>
                    <span className="value">
                      {totalUsage.totalTokens.toLocaleString()} tokens
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}