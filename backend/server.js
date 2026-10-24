// backend/server.js
// ======================================================
// OPSMATE BACKEND — Ollama (local LLM) + PostgreSQL answer cache
//
// REQUEST FLOW (fastest first)
//   0. Scope gate      : greeting -> canned reply; off-topic -> canned decline (no LLM, no cache)
//   1. Order fast-path : plain status question + order id -> Postgres lookup -> templated answer (no LLM)
//   2. L1 memory cache : ~1 ms, per-process LRU + TTL   (SKIPPED for order queries, see FIX #2 below)
//   3. L2 PostgreSQL   : persistent exact-match cache (query_cache table)  (SKIPPED for order queries)
//   4. Ollama + MCP tools : model calls get_order / list_orders / check_stock / update_stock
//      (shared with the standalone mcp/ MCP server) whenever it needs order or
//      inventory data, then streams the final answer grounded in that tool's result.
//
// No Vercel AI SDK, no OpenAI / Anthropic / Gemini, no Supabase, no Upstash:
// the only model provider is a local Ollama daemon.

"use strict";

const path = require("path");
const http = require("http");
const crypto = require("crypto");
const dotenv = require("dotenv");
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const zod = require("zod");
const { Ollama } = require("ollama");
const { ensureSchema } = require("./schema");
const { createTools } = require("../mcp/tools");
const { createAuth } = require("../mcp/auth");
// Company Policy MCP Resource (opsmate://company/policy) — the SAME loader the
// MCP servers register (see ../mcp/resources.js), so the policy text MCP
// clients read and the text injected into the model context are identical.
const { getPolicyDocument, POLICY_URI: POLICY_RESOURCE_URI } = require("../mcp/resources");


const z = zod.z || zod;

// ======================================================
// ENVIRONMENT
// ======================================================

// backend/.env loads first and still wins over the root .env, but values
// already present in the process environment (e.g. an explicit PORT for
// running a second instance in another Docker container) are respected.
dotenv.config({ path: path.resolve(__dirname, ".env") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const PORT = Number(process.env.PORT || 5000);

// ---------- Ollama (the ONLY model provider) ----------
const ollamaHost = process.env.OLLAMA_HOST || "http://localhost:11434";
const ollamaModel = process.env.OLLAMA_MODEL || "llama3.2:3b";

// Kept for backwards compatibility; anything other than "ollama" is ignored.
const aiProvider = (process.env.AI_PROVIDER || "ollama").toLowerCase();

const providerLabel = "ollama";

// ---------- Latency / generation ----------
// Ceilings are for a CPU-only Ollama: prompt eval of the ~2k-token system prompt
// alone can exceed 30s there, so the watchdog must not kill a working request.
const AI_REQUEST_TIMEOUT_MS = Number(
  process.env.OLLAMA_TIMEOUT_MS || process.env.AI_REQUEST_TIMEOUT_MS || 600000,
);
const FIRST_TOKEN_TIMEOUT_MS = Number(
  process.env.OLLAMA_FIRST_TOKEN_TIMEOUT_MS || 180000,
);
// The system prompt already asks for 1-2 short sentences: capping output is the single
// biggest latency lever on CPU-only Ollama (generation is ~0.3-2 tok/s there).
// 48 tokens is roughly two short sentences + a little headroom.
const AI_MAX_TOKENS = Number(
  process.env.AI_MAX_TOKENS || process.env.OLLAMA_NUM_PREDICT || 80,
);
// MULTI ROUND-TRIP REQUESTS: how many tool round-trips a single question may
// take. Round 1 = the plain decision turn; every round after that runs because
// the model ANSWERED with tool_calls and wants the results in context to
// continue. One final streamed, tool-grounded answer is forced once the budget
// is exhausted, so a tool-calling loop can never run away.
const AI_MAX_TOOL_ROUNDS = Math.min(
  Math.max(Number(process.env.AI_MAX_TOOL_ROUNDS || 4), 1),
  10,
);
// Keeping the model resident in RAM removes the multi-second cold load on every request.
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || "30m";
// A smaller context than the model default (128k) massively cuts prompt-eval time.
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 4096);
const OLLAMA_TEMPERATURE = Number(process.env.OLLAMA_TEMPERATURE || 0.2);
const OLLAMA_WARMUP =
  String(process.env.OLLAMA_WARMUP || "true").toLowerCase() === "true";

const ORDER_FAST_PATH =
  String(process.env.ORDER_FAST_PATH || "true").toLowerCase() === "true";
const ORDER_CACHE_TTL_MS = Number(process.env.ORDER_CACHE_TTL_MS || 10000);

// ---------- Cache ----------
const CACHE_ENABLED =
  String(process.env.CACHE_ENABLED || "true").toLowerCase() === "true";
const CACHE_L1_TTL_SEC = Number(process.env.CACHE_L1_TTL_SEC || 300);
const CACHE_L1_MAX = Number(process.env.CACHE_L1_MAX || 500);
const CACHE_TTL_SEC = Number(process.env.CACHE_TTL_SEC || 60 * 60 * 24); // generic answers: 24h
const CACHE_LIVE_TTL_SEC = Number(process.env.CACHE_LIVE_TTL_SEC || 60); // queries with digits/email: 60s
// Postgres on Docker/Windows can take several seconds on a cold connection, so
// the cache I/O ceiling is generous — a cold connect measured ~12s locally, and
// cacheDb() retries once on a now-warm socket when the first attempt times out.
const CACHE_DB_TIMEOUT_MS = Number(process.env.CACHE_DB_TIMEOUT_MS || 15000);

// ======================================================
// POLICY RESOURCE
// ======================================================
// Provides the company policy document via API for AI grounding
// and frontend display. Policy file: docs/policy.md
// ======================================================
function loadPolicy() {
  const policyPath = path.join(__dirname, '..', 'docs', 'policy.md');
  try {
    const fs = require('fs');
    return fs.readFileSync(policyPath, 'utf-8');
  } catch (_e) {
    return 'Policy document not found. See docs/policy.md for configuration.';
  }
}

// ======================================================
// SEMANTIC cache (pgvector + Ollama embeddings) ----------
// Trace infrastructure: streams pipeline steps to the UI browser panel
// ============================================================

// Encodes a trace event into a serializable format for streaming to the browser.
// Keeps only the fields the frontend needs; discards internal metadata.
function encodeTrace(event, stepNumber = 0) {
  return {
    n: typeof event.n === "number" ? event.n : stepNumber,
    stage: event.stage,
    status: event.status || "ok",
    title: event.title,
    detail: event.detail,
    ms: event.ms,
  };
}

// Creates a trace object with a .stage() method that emits pipeline steps.
// When STREAM_TRACE_ENABLED is true, each stage() call forwards the event
// to the onEvent callback (which typically writes to the WebSocket stream).
function createTracer({ onEvent } = {}) {
  let stepIndex = 0;
  function stage(event) {
    stepIndex += 1;
    const encoded = encodeTrace(event, stepIndex);
    if (onEvent) {
      try {
        onEvent(encoded);
      } catch (_e) {
        // onEvent failure should never break the request pipeline
      }
    }
    // Return the stage string for potential downstream use
    return encoded.stage;
  }
  return { stage };
}

// Every cached answer is stored WITH the query's embedding so a rephrased
// (not byte-identical) question can still be served from the cache.
const SEMANTIC_CACHE_ENABLED =
  String(process.env.SEMANTIC_CACHE_ENABLED || "true").toLowerCase() === "true";
// OLLAMA_EMBEDDING_MODEL is accepted too: it is the name used in .env, and
// reading only OLLAMA_EMBED_MODEL silently ignored that setting.
const EMBED_MODEL =
  process.env.OLLAMA_EMBED_MODEL ||
  process.env.OLLAMA_EMBEDDING_MODEL ||
  "nomic-embed-text:latest";
// nomic-embed-text emits 768-dim vectors — must match the query_cache.embedding column.
const EMBED_DIM = Number(process.env.EMBEDDING_DIM || 768);
const EMBED_TIMEOUT_MS = Number(process.env.EMBED_TIMEOUT_MS || 15000);
// Cosine similarity (1 - distance) required for a semantic cache hit.
// Calibrated on nomic-embed-text with real support queries on this setup:
// true paraphrases score ~0.93-0.96, topic neighbours (warranty vs price of
// the same product) ~0.72-0.74, unrelated questions ~0.46-0.66. 0.80 keeps
// genuine paraphrases and rejects topic neighbours.
const SEMANTIC_MIN_SIMILARITY = Number(
  process.env.SEMANTIC_MIN_SIMILARITY ||
    process.env.SEMANTIC_CACHE_THRESHOLD ||
    0.8,
);
// Second gate on top of the similarity score: the two questions must also
// share most of their content words. Similarity alone matches "warranty
// period on the wireless mouse" against the cached "price of the wireless
// mouse" (0.74) and serves the price answer for a warranty question — a
// false hit is worse than a miss. With >= 0.6 overlap the paraphrases above
// still hit (0.67-1.0) while the warranty question is rejected (0.5).
const SEMANTIC_MIN_WORD_MATCH = Number(
  process.env.SEMANTIC_MIN_WORD_MATCH || 0.6,
);

// ======================================================
// SMALL HELPERS
// ======================================================

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const nowMs = () => performance.now();

function makeError(message, status, code) {
  const e = new Error(message);
  if (status) e.status = status;
  if (code) e.code = code;
  return e;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Tiny LRU + TTL cache (Map keeps insertion order)
class TTLCache {
  constructor(max = 500) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.exp <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry); // refresh recency
    return entry.value;
  }
  set(key, value, ttlMs) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, exp: Date.now() + ttlMs });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  clear() {
    this.map.clear();
  }
  get size() {
    return this.map.size;
  }
}

// ======================================================
// EXPRESS
// ======================================================

const app = express();
app.disable("x-powered-by");
app.set("etag", false);
app.use(cors({ origin: true, methods: ["GET", "POST", "OPTIONS"] }));
app.use(express.json({ limit: "1mb" }));

// ======================================================
// POSTGRESQL  (orders + persistent answer cache)
// ======================================================

const rawDatabaseUrl = process.env.DATABASE_URL || "";
const databaseUrl = rawDatabaseUrl.includes("@postgres:")
  ? rawDatabaseUrl.replace("@postgres:", "@localhost:")
  : rawDatabaseUrl;

if (rawDatabaseUrl !== databaseUrl) {
  console.warn(
    "[DB] DATABASE_URL used Docker hostname 'postgres' — switched to 'localhost' for local dev.",
  );
}

const pool = new Pool({
  connectionString: databaseUrl || undefined,
  max: Number(process.env.PG_POOL_MAX || 10),
  // Keep TCP sockets alive: on this setup a cold connection costs ~12s, which
  // would otherwise show up as a "cache timeout" on the first cached request.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  // FIX ("Connection terminated due to connection timeout" in search_products):
  // idleTimeoutMillis was 60000, so every pooled socket was evicted after one
  // minute of quiet. A tool call fired mid-request (when the pool was empty)
  // then had to open a FRESH Docker/Windows connection (~12s cold, frequently
  // longer while Ollama saturates the CPU during the same request) and pg-pool
  // force-destroys any new connection whose handshake runs past
  // connectionTimeoutMillis — which is exactly the pg-pool error text
  // "Connection terminated due to connection timeout". Ten minutes of idle
  // retention (with the TCP keepAlive above holding the socket through the
  // Docker NAT) makes that a rare, genuine-failure path instead of the normal
  // state of the pool; the connectionTimeoutMillis ceiling below is UNCHANGED.
  idleTimeoutMillis: 600000,
  connectionTimeoutMillis: 15000,
  statement_timeout: 10000,
  query_timeout: 10000,
});

let dbReady = false;

pool.on("error", (e) => {
  dbReady = false;
  console.error("[DB] idle client error:", e.message);
});

// MCP tools (get_order, list_orders, check_stock, search_products, update_stock)
// bound to THIS
// backend's own pool — no second DB connection is opened. Same tool logic as
// the standalone mcp/ MCP server (mcp/tools.js), shared via createTools().
//
// AUTH (ADDITIVE, SERVER-VERIFIED):
//   Tool handlers now require a verified auth context. The backend acts as a
//   trusted SERVICE using MCP_SERVICE_TOKEN from backend/.env — an opaque
//   session token resolved against the database for EVERY tool call (so
//   revocation or expiry takes effect without a restart). The token maps to
//   a dedicated service account created with
//     cd ../mcp && ADMIN_PASSWORD=... node scripts/create-admin.js \
//       --name "OpsMate Service" --email service@opsmate.local --token --ttl-days 365
//   Fail closed: an unset or invalid token means every tool call returns an
//   authentication-required error instead of silently executing.
const mcpTools = createTools(pool, createAuth(pool));

// Resolves the service session token to a VERIFIED context { userId, role,
// ... } per call. Never trusts anything else (no identity from model output
// or request data). Returns null when unconfigured — the tool handlers fail
// closed on a null context.
async function getMcpServiceContext() {
  const token = process.env.MCP_SERVICE_TOKEN;
  if (!token) return null;
  return mcpTools.auth.resolveSessionToken(token);
}

// NOTE: all CREATE TABLE / CREATE EXTENSION / ALTER TABLE / CREATE INDEX
// statements (query_cache, its pgvector embedding-cache columns + index, and
// the queries audit table) now live in ./schema.js — see ensureSchema()
// imported above and invoked once at the bottom of this file, in the
// server.listen() startup callback.

// ======================================================
// OLLAMA CLIENT
// ======================================================

const ollama = new Ollama({ host: ollamaHost, fetch: globalThis.fetch });

/**
 * A per-request Ollama client whose fetch carries the caller's abort signal.
 *
 * ollama-js only attaches an AbortController to STREAMED calls, so a
 * non-streaming call (the orderLookup "decision" turn in
 * askOllamaWithOrderTool) could not be cancelled once it started: the client
 * pressed Stop and the model kept generating until that turn finished. Passing
 * the signal through a scoped client closes that gap without leaking one
 * request's signal into another's.
 *
 * Only used for non-streaming turns — streamed calls keep their own internal
 * AbortController (aborted via iterator.abort()).
 */
function ollamaClientFor(signal) {
  if (!signal) return ollama;
  return new Ollama({
    host: ollamaHost,
    fetch: (input, init) => globalThis.fetch(input, { ...init, signal }),
  });
}

const clientAborted = () =>
  makeError("Request stopped by the client", 499, "CLIENT_ABORTED");

let ollamaReady = false;
let ollamaLastError = null;

// Conversation memory is bounded server-side to the latest complete turns so the
// prompt contract holds no matter what the client sends. MAX_HISTORY_MESSAGES is
// expressed in TURNS (one user + one assistant message per turn).
const MAX_CONVERSATION_TURNS = Math.max(
  1,
  Number(process.env.MAX_HISTORY_MESSAGES || 3),
);

function sanitizeHistory(history, currentQuery) {
  const rows = (Array.isArray(history) ? history : [])
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim(),
    )
    .map((m) => ({ role: m.role, content: m.content }));

  // Some clients echo the current message as the last history entry: drop it so
  // the prompt never contains the current user message twice.
  const normCurrent = normalizeQuery(currentQuery);
  while (
    rows.length &&
    rows[rows.length - 1].role === "user" &&
    normalizeQuery(rows[rows.length - 1].content) === normCurrent
  ) {
    rows.pop();
  }

  // Group into turns and keep only the latest complete (user + assistant) pairs.
  const turns = [];
  for (const m of rows) {
    if (m.role === "user") turns.push([m]);
    else if (turns.length && turns[turns.length - 1].length === 1)
      turns[turns.length - 1].push(m);
  }

  return turns
    .filter((t) => t.length === 2)
    .slice(-MAX_CONVERSATION_TURNS)
    .flat();
}

// Stable fingerprint of the conversation context (the previous 3 completed
// requests) that reaches the model. The answer cache must key on this too:
// two identical questions with DIFFERENT history must never share a cached
// answer, because an answer that was computed with other conversation context
// read wrong when replayed under a follow-up question ("and what about 1002?"
// vs "what is a wireless mouse"). Returns null for a standalone question so
// history-free keys keep sharing the generic cache across sessions.
function historyFingerprint(history, currentQuery) {
  const msgs = sanitizeHistory(history, currentQuery);
  if (!msgs.length) return null;
  return sha(
    msgs
      .map((m) => `${m.role}:${normalizeQuery(m.content)}`)
      .join("|"),
  ).slice(0, 12);
}

function classifyOllamaError(error) {
  const message = String(error?.message || error || "");
  if (error?.code && FRIENDLY_ERRORS[error.code]) return error;

  if (
    /ECONNREFUSED|fetch failed|connect ECONNREFUSED|socket hang up|Connection refused/i.test(
      message,
    )
  ) {
    return makeError(
      `Ollama is not reachable at ${ollamaHost}`,
      503,
      "OLLAMA_UNAVAILABLE",
    );
  }
  if (
    /model .*not found|try pulling|no such model|pull model manifest/i.test(
      message,
    )
  ) {
    return makeError(
      `Ollama model "${ollamaModel}" is not installed`,
      503,
      "MODEL_NOT_FOUND",
    );
  }
  if (
    error?.name === "AbortError" ||
    /aborted|timed out|timeout/i.test(message)
  ) {
    return makeError(
      `Ollama timed out after ${AI_REQUEST_TIMEOUT_MS}ms`,
      504,
      "AI_TIMEOUT",
    );
  }
  return makeError(
    message || "Ollama request failed",
    500,
    "AI_REQUEST_FAILED",
  );
}

const safeJsonParse = (s) => {
  try {
    return JSON.parse(s);
  } catch (_e) {
    return {};
  }
};

function usageFromOllamaResponse(resp) {
  const promptTokens = resp?.prompt_eval_count ?? 0;
  const completionTokens = resp?.eval_count ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

/**
 * Streams ONE already-built Ollama chat completion (no tools — this is the
 * final answer-generation turn, used both for plain chat and for the
 * post-tool-call follow-up in askOllamaWithOrderTool()).
 * @param {Array<{role:string,content:string}>} messages
 * @param {{onDelta?: (chunk: string) => void, signal?: AbortSignal, usedTool?: boolean,
 *          trace?: (event: object) => void}} opts
 */
async function streamOllamaCompletion(
  messages,
  { onDelta, signal, usedTool = false, trace, maxTokens = AI_MAX_TOKENS } = {},
) {
  const startedAt = nowMs();
  let iterator = null;
  let firstTokenTimer = null;
  let hardTimer = null;

  const abortUpstream = () => {
    try {
      iterator?.abort();
    } catch (_e) {
      /* already closed */
    }
  };

  try {
    iterator = await ollama.chat({
      model: ollamaModel,
      messages,
      stream: true,
      keep_alive: OLLAMA_KEEP_ALIVE,
      options: {
        temperature: OLLAMA_TEMPERATURE,
        num_predict: maxTokens,
        num_ctx: OLLAMA_NUM_CTX,
      },
    });

    if (signal) {
      if (signal.aborted) abortUpstream();
      else signal.addEventListener("abort", abortUpstream, { once: true });
    }

    // Hard ceiling on the whole call, plus a watchdog for a wedged first token.
    hardTimer = setTimeout(abortUpstream, AI_REQUEST_TIMEOUT_MS);
    firstTokenTimer = setTimeout(abortUpstream, FIRST_TOKEN_TIMEOUT_MS);

    let answer = "";
    let firstTokenMs = null;
    let finalPart = null;
    let sawFirstToken = false;
    let firstToolToken = true;

    for await (const part of iterator) {
      const chunk = part?.message?.content || "";
      // num_predict=100 truncated "the list below:" right before the list on
      // ~10-token/second CPU generation: everything the user saw was a
      // pointer to a list the model never got to write. Raise the cap for
      // tool-grounded answers (a 12-row summary needs room) and emit the
      // trace immediately so the header reflects it.
      if (chunk) {
        if (!sawFirstToken) {
          sawFirstToken = true;
          firstTokenMs = Number((nowMs() - startedAt).toFixed(1));
          if (firstTokenTimer) {
            clearTimeout(firstTokenTimer);
            firstTokenTimer = null;
          }
          // Emitted BEFORE this first delta reaches onDelta, so the trace line
          // always lands ahead of the answer text it describes.
          trace?.({
            stage: "answer",
            status: "run",
            title: "Answer streaming",
            detail: `${ollamaModel} · first token ${firstTokenMs}ms${
              firstToolToken
                ? " · output cap raised for tool-grounded answer"
                : ""
            }`,
          });
          firstToolToken = false;
        }
        answer += chunk;
        if (onDelta) onDelta(chunk);
      }
      if (part?.done) finalPart = part;
    }

    if (!sawFirstToken) {
      throw makeError("Ollama returned an empty response", 504, "AI_TIMEOUT");
    }

    // The client pressed Stop: never treat a half-streamed answer as complete,
    // and above all do NOT let it reach the cache.
    if (signal?.aborted) throw clientAborted();

    ollamaReady = true;
    ollamaLastError = null;

    return {
      answer: answer.trim(),
      model: ollamaModel,
      usage: usageFromOllamaResponse(finalPart),
      usedTool,
      firstTokenMs,
      elapsedMs: Number((nowMs() - startedAt).toFixed(1)),
    };
  } catch (error) {
    // A deliberate client-side stop is not a provider failure: never flip the
    // health flag, and never surface it as an error to a gone client.
    if (signal?.aborted || error?.code === "CLIENT_ABORTED") {
      throw clientAborted();
    }
    ollamaReady = false;
    ollamaLastError = String(error?.message || error);
    throw classifyOllamaError(error);
  } finally {
    if (firstTokenTimer) clearTimeout(firstTokenTimer);
    if (hardTimer) clearTimeout(hardTimer);
    if (signal) signal.removeEventListener("abort", abortUpstream);
  }
}

function formatToolArgs(args) {
  if (!args || typeof args !== "object") return "";
  return Object.entries(args)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
}

function describeToolResult(name, result) {
  if (!result) return "empty result";
  if (result.error) return `error: ${result.error}`;
  if (Array.isArray(result)) return `${result.length} item(s)`;
  if (typeof result === "object") {
    if (result.orders && Array.isArray(result.orders)) return `${result.orders.length} order(s)`;
    if (result.products && Array.isArray(result.products)) return `${result.products.length} product(s)`;
    if (result.status) return `status: ${result.status}`;
    return Object.keys(result).slice(0, 3).join(", ");
  }
  return String(result).slice(0, 50);
}

function queryRequiresMultiTool(query) {
  const q = String(query || "").toLowerCase();

  // Multi-step intent indicators:
  const compoundPatterns = [
    /\b(and|then|also)\b[\s\S]*\b(check|verify|find|get|list|update|inspect|see)\b/i,
    /\b(each|every)\b[\s\S]*\b(stock|product|item|order|available|inventory)\b/i,
    /\b(whether|if)\b[\s\S]*\b(in stock|available|fulfilled|can be fulfilled)\b/i,
    /\b(cannot be fulfilled|insufficient stock|out of stock)\b/i,
    /\b(which|what)\b[\s\S]*\b(orders|products)\b[\s\S]*\b(cannot|can|are|have)\b/i,
  ];

  for (const pattern of compoundPatterns) {
    if (pattern.test(q)) return true;
  }

  // Cross-entity check: mentions both orders and product inventory
  const mentionsOrders = /\b(order|orders|ordered)\b/i.test(q);
  const mentionsStock = /\b(stock|stocks|inventory)\b/i.test(q);
  if (mentionsOrders && mentionsStock) return true;

  // Multiple order IDs mentioned
  const orderMatches = q.match(/\b(?:ord[-_\s]?)?\d{4,}\b/gi);
  if (orderMatches && orderMatches.length > 1) return true;

  return false;
}

// ======================================================
// POLICY ROUTING / GROUNDING (Company Policy MCP Resource)
// ======================================================

// Policy INTENT: the question is about returns, refunds, warranty, shipping
// windows, RMA, escalation, chargebacks or eligibility. This alone does NOT
// decide the routing — it attaches the policy context; whether the order /
// product tools stay available is decided by isPolicyOnlyQuery() below.
// 'return window' phrasing like "What is the standard return window?" must
// never fall through to search_products again (the model was previously sent
// a 3B decision turn with FIVE DB tools and ZERO policy data, so it could
// only mis-select a tool or invent a window like "14 days" instead of
// retaining the resource's exact "14-30 days" range).
const POLICY_INTENT_RE =
  /\b(return|returns|returning|refund|refunds|refunded|warranty|warranties|guarantee|rma|escalat\w*|chargeback\w*|eligi\w*|polic\w*|window)\b/i;

// MIXED-query markers: anything here means the question ALSO wants live
// order/product data, so the MCP tools remain available next to the policy
// context (e.g. "can I return my wireless mouse and how much does it cost?").
const PRODUCT_CONTEXT_RE =
  /\b(orders?|ordered|tracking|track\w*|price|prize|cost|stock|inventory|quantit\w*|product\w*|item\w*|sku\w*|payment\w*)\b/i;

const hasPolicyIntent = (query) => POLICY_INTENT_RE.test(String(query || ""));

// A POLICY-ONLY question needs no database row at all: answered strictly from
// the Company Policy Resource, with the DB tools WITHHELD from the decision
// turn so search_products/get_order can never be the model's source here.
// Defined at module scope but reading later-declared consts (extractOrderId,
// SKU_REFERENCE_RE, HOW_MUCH_RE): by the time a request runs they are all
// initialized, so call-time evaluation is safe.
function isPolicyOnlyQuery(query) {
  const q = String(query || "");
  return (
    hasPolicyIntent(q) &&
    !extractOrderId(q) &&
    !SKU_REFERENCE_RE.test(q) &&
    !HOW_MUCH_RE.test(q) &&
    !PRODUCT_CONTEXT_RE.test(q)
  );
}

// The exact text injected into the Ollama context for a policy question — the
// document content read by getPolicyDocument(), the same loader that backs the
// MCP Resource opsmate://company/policy (mcp/resources.js).
function policyContextBlock(policyDoc) {
  return (
    "COMPANY POLICY (authoritative source, read from the Company Policy MCP " +
    `Resource ${POLICY_RESOURCE_URI}) — answer from these exact values; ` +
    "preserve every range, condition and exception exactly as written, and " +
    "do not narrow a range (e.g. \"14-30 days\" stays \"14-30 days\"):\n\n" +
    policyDoc +
    "\nIf the answer is not in this document, say the information cannot be " +
    "verified rather than guessing."
  );
}

// Policy intent with an UNREADABLE document: never invent — inject an explicit
// grounding failure block so the model declines instead of improvising a rule.
const POLICY_UNAVAILABLE_BLOCK =
  "COMPANY POLICY: the Company Policy MCP Resource could not be read right " +
  "now. Do not invent any policy value. Say the policy information cannot be " +
  "verified at the moment and suggest contacting the merchant directly.";

/**
 * The ONLY entry point for an answer that needs the LLM and MAY need order or
 * inventory data.
 *
 * MULTI ROUND-TRIP tool-calling flow — this is what guarantees the model can
 * never guess order/stock data:
 *   Round 1 (non-streaming "decision" turn, with all 5 MCP tools offered):
 *            the model either answers directly (no DB data needed — e.g.
 *            "what's your return window?") or emits one or more tool_calls
 *            (get_order / list_orders / check_stock / update_stock).
 *   Round 2..AI_MAX_TOOL_ROUNDS (only if the previous round answered with
 *            tool_calls): callMcpTool() runs the REAL handler for each
 *            tool_call (shared with the standalone mcp/ MCP server), the
 *            result is appended to the conversation as a `tool` message, and
 *            the model gets a NEW decision turn with all tool results in
 *            context — so a single question can chain several lookups
 *            (e.g. list_orders, then check_stock on one of the rows).
 *   Final turn: the answer, whenever it arrives, is grounded ONLY in real
 *            tool output — never in anything the model recalled or invented.
 *            If the round budget is exhausted, one final streamed turn is
 *            forced so a tool-calling loop can never run away.
 */
async function askOllamaWithOrderTool(
  query,
  { onDelta, signal, history = [], trace, context = null } = {},
) {
  const isMultiToolNeeded = queryRequiresMultiTool(query);
  // POLICY ROUTING: a policy question gets the Company Policy Resource content
  // (and, if it is policy-ONLY, none of the DB tools). Registration of the
  // resource alone does not ground the model — this injection is why the
  // answer can actually cite the resource's "14-30 days" window.
  const policyWanted = hasPolicyIntent(query);
  const policyOnly = isPolicyOnlyQuery(query);
  const policyDoc = policyWanted ? getPolicyDocument() : null;
  const maxRounds = isMultiToolNeeded ? AI_MAX_TOOL_ROUNDS : 1;
  const messages = [
    { role: "system", content: OPSMATE_SYSTEM_PROMPT },
    ...(policyWanted
      ? [
          {
            role: "system",
            content: policyDoc ? policyContextBlock(policyDoc) : POLICY_UNAVAILABLE_BLOCK,
          },
        ]
      : []),
    ...sanitizeHistory(history, query),
    { role: "user", content: query },
  ];

  const decisionClient = ollamaClientFor(signal);
  const usedToolNames = [];
  const executedCalls = new Set();
  let completedRounds = 0;

  for (let round = 1; round <= maxRounds; round++) {
    completedRounds = round;
    trace?.({
      stage: "route",
      title: `Round ${round}/${maxRounds}`,
      detail: usedToolNames.length
        ? `round-trip ${round} · ${usedToolNames.length} tool result(s) in context`
        : policyOnly
          ? "decision turn · policy-only · tools withheld"
          : "decision turn with MCP tools offered",
    });

    // One visible trace step for the policy grounding, emitted on the first
    // round only: the UI shows exactly whether the Resource was attached.
    if (round === 1 && policyWanted) {
      trace?.({
        stage: "policy",
        status: policyDoc ? "ok" : "error",
        title: policyDoc
          ? "Policy Resource context attached"
          : "Policy Resource unavailable",
        detail: policyOnly
          ? `policy-only question · DB tools withheld · grounded from ${POLICY_RESOURCE_URI} · ${String(policyDoc || "").length} chars`
          : "mixed question · policy context + order/product tools both available",
      });
    }

    let decision;
    try {
      decision = await withTimeout(
        decisionClient.chat({
          model: ollamaModel,
          messages,
          // POLICY-ONLY questions get NO tools at all: the answer must come
          // from the Policy Resource context above, and withholding the DB
          // tools makes a wasted search_products/get_order call impossible.
          // Mixed policy+product/order questions keep all five tools and
          // instead ground their policy part via the context injection.
          tools: policyOnly ? [] : MCP_TOOLS_FOR_OLLAMA,
          stream: false,
          keep_alive: OLLAMA_KEEP_ALIVE,
          options: {
            temperature: OLLAMA_TEMPERATURE,
            num_predict: AI_MAX_TOKENS,
            num_ctx: OLLAMA_NUM_CTX,
          },
        }),
        AI_REQUEST_TIMEOUT_MS,
        `ollama.chat (round ${round})`,
      );
    } catch (error) {
      // A deliberate client-side stop is not a provider failure: never flip
      // the health flag, and let the caller report CLIENT_ABORTED instead.
      if (
        signal?.aborted ||
        error?.name === "AbortError" ||
        error?.code === "CLIENT_ABORTED"
      ) {
        throw clientAborted();
      }
      ollamaReady = false;
      ollamaLastError = String(error?.message || error);
      throw classifyOllamaError(error);
    }

    // The client may have pressed Stop while the decision turn was in flight:
    // stop before any tool lookup or follow-up completion is started.
    if (signal?.aborted) throw clientAborted();

    ollamaReady = true;
    ollamaLastError = null;

    const toolCalls = decision?.message?.tool_calls || [];

    // No tool needed: the model answered directly — a support-policy question
    // with no DB data attached, OR the final grounded answer after one or more
    // earlier tool round-trips. Either way this content completes the request.
    if (!toolCalls.length) {
      const answer = String(decision?.message?.content || "").trim();
      if (!answer) {
        // Round 1 with empty content: no fallback material at all.
        // Later rounds: real tool results are already in context — drop into
        // the forced streamed final turn below instead of failing the request.
        if (!usedToolNames.length)
          throw makeError(
            "Ollama returned an empty response",
            504,
            "AI_TIMEOUT",
          );
        trace?.({
          stage: "tool",
          title: "Empty round answer",
          detail: "forcing one final grounded answer from tool results",
        });
        break;
      }
      trace?.({
        stage: "answer",
        title: "Model answered",
        detail: usedToolNames.length
          ? `after ${round} round(s) · tools: ${usedToolNames.join(", ")}`
          : "no order/stock data needed",
      });
      if (onDelta) onDelta(answer);
      return {
        answer,
        model: ollamaModel,
        usage: usageFromOllamaResponse(decision),
        usedTool: usedToolNames.length > 0,
        tool: usedToolNames.join(", ") || null,
        rounds: round,
      };
    }

    // The model asked for one or more MCP tools — run EVERY one of them
    // against the real database. This is the only place order/inventory data
    // enters the conversation.
    // WHICH tool the model picked (and in what order) is exactly what the
    // trace shows: selection -> call -> result -> RESULTS BACK TO THE MODEL ->
    // next round -> grounded answer.
    const roundToolNames = toolCalls
      .map((call) => call?.function?.name)
      .filter(Boolean);
    trace?.({
      stage: "tool",
      status: "run",
      title: `Round ${round}: tool(s) selected by the model`,
      detail: roundToolNames.join(", ") || "unnamed tool",
    });

    // Append the assistant's tool-call turn FIRST, then one `tool` message per
    // result — the exact shape Ollama expects to continue a tool conversation.
    messages.push(decision.message);

    for (const call of toolCalls) {
      const name = call?.function?.name;
      const rawArgs = call?.function?.arguments;
      const args =
        typeof rawArgs === "string" ? safeJsonParse(rawArgs) : rawArgs || {};

      const callKey = `${name}:${JSON.stringify(args)}`;
      if (executedCalls.has(callKey)) {
        trace?.({
          stage: "tool",
          status: "skip",
          title: `Skipping duplicate ${name}`,
          detail: "already called in previous round with identical arguments",
        });
        continue;
      }
      executedCalls.add(callKey);

      trace?.({
        stage: "tool",
        status: "run",
        title: `Calling ${name}`,
        detail: formatToolArgs(args),
      });

      const toolStartedAt = nowMs();
      const result = await callMcpTool(name, args, context);

      trace?.({
        stage: "tool",
        status: result?.error ? "error" : "ok",
        title: `${name} returned`,
        detail: describeToolResult(name, result) || "ok",
        ms: nowMs() - toolStartedAt,
      });

      messages.push({ role: "tool", content: JSON.stringify(result) });
    }

    usedToolNames.push(...roundToolNames);

    // When the user's question does NOT require multi-step chaining (e.g. simple
    // listing, single order status, product price/stock), 1 successful tool call
    // round is completely sufficient — do not call tools multiple times.
    if (!isMultiToolNeeded && usedToolNames.length > 0) {
      break;
    }
  }

  // Generate the final streamed answer grounded in the tool result(s).
  trace?.({
    stage: "tool",
    title: isMultiToolNeeded ? "Round budget reached" : "Tool results ready",
    detail: `${usedToolNames.length} tool result(s) in context · generating grounded answer`,
  });
  const final = await streamOllamaCompletion(
    [
      ...messages,
      // Strict grounding instruction for the final turn ONLY: with a 3B model
      // the decision turn sometimes flows straight into a next-step suggestion
      // in the follow-up call, producing replies that contain tool data but
      // never say it. (Observed: "list all orders" -> list_orders -> "Next
      // step: Review the list of orders..." and nothing else.)
      {
        role: "user",
        content:
          "Now write the final answer to the customer's question. Ground it ONLY in " +
          "the tool result(s) above — every order/product value you state must come from " +
          "those results. If the result was a list, present the actual rows (id, status " +
          "and any field the customer asked about); never end without them, never write " +
          "only a 'next step' suggestion, and never suggest reviewing or checking again. " +
          "Keep it to a few short lines.",
      },
    ],
    {
      onDelta,
      signal,
      usedTool: true,
      trace,
      maxTokens: Math.max(AI_MAX_TOKENS, 400),
    },
  );
  return {
    ...final,
    tool: usedToolNames.join(", ") || null,
    rounds: completedRounds,
  };
}

// Loads the model into memory so the first real user request doesn't pay the load cost.
async function warmUpOllama() {
  if (!OLLAMA_WARMUP) return;
  const t0 = nowMs();
  try {
    await ollama.chat({
      model: ollamaModel,
      messages: [{ role: "user", content: "ok" }],
      stream: false,
      keep_alive: OLLAMA_KEEP_ALIVE,
      options: { num_predict: 1, num_ctx: OLLAMA_NUM_CTX },
    });
    ollamaReady = true;
    console.log(
      `[Warmup] Ollama ready: ${ollamaModel} loaded in ${Math.round(nowMs() - t0)}ms (keep_alive=${OLLAMA_KEEP_ALIVE})`,
    );
  } catch (e) {
    ollamaReady = false;
    ollamaLastError = e.message;
    console.warn(`[Warmup] Ollama not ready: ${e.message}`);
  }
}

// ======================================================
// EMBEDDINGS  (semantic / embedding cache)
// ======================================================

// Best-effort embedding for the semantic cache tier.
// Returns number[] on success, null on ANY failure — a missing vector must
// never break the answer path (the row is then stored without one).

async function embedQuery(text) {
  const input = String(text ?? "").trim();
  if (!input) return null;

  try {
    const res = await withTimeout(
      ollama.embed({
        model: EMBED_MODEL,
        input,
        keep_alive: OLLAMA_KEEP_ALIVE,
        truncate: true,
      }),
      EMBED_TIMEOUT_MS,
      "ollama.embed",
    );

    const vec = res?.embeddings?.[0];

    if (
      !Array.isArray(vec) ||
      vec.length === 0 ||
      !vec.every(Number.isFinite)
    ) {
      throw new Error("Embedding missing or non-numeric in Ollama response");
    }

    return vec;
  } catch (e) {
    console.warn(
      `[Embed] ${EMBED_MODEL} failed (row stored without vector): ${e.message}`,
    );
    return null;
  }
}

// pgvector wants the literal '[0.1,0.2,...]' text form.
const toVectorLiteral = (vec) => `[${vec.join(",")}]`;

// ======================================================
// SYSTEM PROMPT
// ======================================================


const OPSMATE_SYSTEM_PROMPT = `\You are OpsMate, an operations assistant for an e-commerce support team.
You never act on the company's behalf.

Conversation: up to the last 3 request/answer turns of this conversation are
included before the user's message. Use them to resolve references ("it",
"that order", "the same product") and answer follow-up questions. When a
follow-up asks about a DIFFERENT order or product, look it up with a tool.
Never reuse values from history for a different order or product.

Response style (highest priority): answer in at most two short sentences,
about 30 words. No greetings, filler, or restating the question.

The FIRST sentence must provide the answer itself, using an exact value
supported by a tool result or available policy/source context. For example:
"The Wireless Mouse costs 499.00." or "Order ORD-1001 is shipped." Use a numbered list only when explicitly asked for a procedure.

Grounding:
Never invent order details, customer names, amounts, dates, tracking numbers,
statuses, product names, prices, stock quantities, or policy requirements.
Use verified tool results and available source context. Never guess when
required information is unavailable.

You have 5 tools backed by the live orders/products database:

get_order: retrieve order details and line items by order_id.

list_orders: list orders, optionally filtered by status.

check_stock: retrieve current stock quantity for a product SKU.

search_products: find a product by full or partial case-insensitive name,
or by SKU, and retrieve its price, stock, and active status.

update_stock: adjust a product's stock by a signed delta. Call it only
when the agent explicitly asks to add or remove stock. Never do so on
your own initiative.

Policy-Related Question Handling (mandatory):

When the user asks a policy-related question, use ONLY the relevant
policy information supplied by the company's Policy Resource in the
current context.

Policy-related questions include questions about refunds, returns,
shipping policies, warranties, eligibility, cancellations, chargebacks,
escalation, fees, delivery rules, and other company policies.

For policy-related questions, NEVER call any MCP tool or any other tool.
This prohibition includes get_order, list_orders, check_stock,
search_products, update_stock, and any policy-resource retrieval tool.

Do not call tools even if the policy question mentions a specific order,
product, SKU, refund status, stock quantity, or customer transaction.

Do not retrieve additional information through tools to answer a policy
question. Use only the Policy Resource content already supplied in the
current conversation context.

Do not use general knowledge, assumptions, previous AI responses, or
invented information to fill gaps in the policy documentation.

Preserve exact policy values, ranges, conditions, exceptions, timeframes,
fees, procedures, and stages. Never replace a range such as "14-30 days"
with a single value such as "14 days" unless the source explicitly
specifies that value.

NEVER invent, assume, modify, or promise policy rules, eligibility,
timeframes, exceptions, approval requirements, or procedures.

If the required policy information is missing, incomplete, ambiguous,
or conflicting in the supplied context, clearly state that the available
policy documentation does not specify or verify the answer.

Policy documentation alone does not establish the actual status of an
individual order, refund, return, payment, or other transaction.
Never claim that an action has been approved, processed, or completed
unless that fact is explicitly supported by the available context.

If a question combines policy information with a request to check or
modify a specific order, answer only the policy-related portion using
the supplied Policy Resource. Do not call tools or perform actions.
If necessary, explain that the specific transaction cannot be verified
from the policy documentation alone.

These policy-specific no-tool rules override the general tool-selection
instructions below whenever the user's question is policy-related.

Tool selection (non-policy questions only):

Call get_order whenever a NON-POLICY question requires an order field,
including status, payment, carrier, tracking number, total, or line items.

Call search_products when actual product information is needed for a
NON-POLICY question, or when a product name or SKU must be resolved.
Search by name first when given.

Call check_stock for stock or inventory availability questions about a
known SKU, provided the question is not policy-related.

Call list_orders when asked to list or filter multiple orders, provided
the request is not policy-related.

Call update_stock only for an explicit stock-change request that is
not part of a policy-related question.

If a name search returns no match, or neither a name nor ID is available,
ask for clarification instead of guessing.

If a tool says an order or product was not found, report that plainly.

Never call a tool for a policy-related question, even if a general
tool-selection rule would otherwise suggest calling one.

Security:

Never disclose passwords, tokens, API keys, connection strings, or other
secrets.

Never bypass authentication, authorization, or tool permission checks.

Do not infer or expose sensitive customer information that is not
returned by an authorized tool.

If a tool reports an authentication or permission error, report the
limitation plainly. Do not attempt to bypass it.

Scope:
No legal, financial, or medical advice, browsing, email, or unauthorized
merchant back-office actions. Make clear when a human must execute an action.

\
`;

const PROMPT_VERSION = sha(OPSMATE_SYSTEM_PROMPT).slice(0, 8); // prompt changes => old cache invalid

// ======================================================
// ORDER LOOKUP  (used by fast-path, LLM context, REST)
// ======================================================

const orderCache = new TTLCache(200);

// "1001" / "ord-1001" / "ORD 1001"  ->  "ORD-1001"
function formatOrderId(raw) {
  const s = String(raw ?? "").trim();
  const m = s.match(/^(?:ord[-_\s]?)?(\d+)$/i);
  return m ? `ORD-${m[1]}` : s.toUpperCase();
}

// Strict pattern: order id sits right next to "ORD-", "order id/no/number/#".
// Matches "ORD-1001", "order id 1001", "order #1001", "order number 1001",
// and — because every piece after "order" is optional — plain "order 1001".
const STRICT_ORDER_ID_RE =
  /\bord[-_\s]?(\d{1,10})\b|\border\s*(?:#|no\.?|number|id)?\s*[:#]?\s*(\d{3,10})\b|#(\d{3,10})\b/i;

// Fallback pattern pieces: used ONLY when the strict pattern above finds
// nothing. If the query mentions "order" anywhere AND contains a bare 3-10
// digit number anywhere, treat that number as the order id. This is what
// makes phrasing like "order status of 1002" or "tell me order status of
// 1001" work — previously "status of" sitting between "order" and the digits
// made the strict pattern miss entirely, so no DB lookup ever ran and the
// query fell through to the LLM, which guessed.
const ORDER_WORD_RE = /\border\b/i;
const BARE_NUMBER_RE = /\b(\d{3,10})\b/;

function extractOrderId(query) {
  const q = String(query);

  const strict = q.match(STRICT_ORDER_ID_RE);
  const strictDigits = strict && (strict[1] || strict[2] || strict[3]);
  if (strictDigits) return `ORD-${strictDigits}`;

  if (ORDER_WORD_RE.test(q)) {
    const fallback = q.match(BARE_NUMBER_RE);
    if (fallback) return `ORD-${fallback[1]}`;
  }

  return null;
}

// Returns row | null (not found). Throws only on DB failure.
//
// AUTHZ: ownerUserId enforces order ownership IN THE SQL ITSELF — a plain
// user can only ever see orders whose user_id matches their own (legacy
// rows with user_id = NULL are hidden too, exactly like list_orders does),
// while admins/service pass null and see everything. The cache is keyed
// PER OWNER, so a row that user A looked up can never be served to user B.
async function lookupOrder(orderId, ownerUserId = null) {
  const id = formatOrderId(orderId);
  const cacheKey = ownerUserId == null ? id : `${id}#${ownerUserId}`;
  const cached = orderCache.get(cacheKey);
  if (cached) return cached;

  const result =
    ownerUserId == null
      ? await pool.query("SELECT * FROM orders WHERE order_id = $1", [id])
      : await pool.query(
          "SELECT * FROM orders WHERE order_id = $1 AND user_id = $2",
          [id, ownerUserId],
        );
  const row = result.rows[0] || null;
  if (row) orderCache.set(cacheKey, row, ORDER_CACHE_TTL_MS);
  return row;
}

// Resolves the Bearer token of an HTTP request to a VERIFIED context, or null
// when no token was sent. Callers must REJECT the request with 401 when a
// token was sent but could not be verified (see authContextFor usage below).
async function authContextFor(req) {
  const token = bearerTokenOf(req);
  if (!token) return { context: null, tokenPresented: false };
  const context = await authApi.resolveSessionToken(token);
  return { context, tokenPresented: true };
}

// Effective order scope for a chat/tool request. Mirrors the MCP orderScope
// helper: verified caller wins (admin sees all, user sees own rows); callers
// with no context fall back to the trusted service account so local usage
// keeps working. Returns the user id rows must belong to, or null for "all".
function orderOwnerUserId(context, serviceContext) {
  const effective = context || serviceContext;
  if (!effective) return null; // unconfigured service token: legacy behavior
  return effective.role === "admin" ? null : effective.userId;
}

// Only non-sensitive columns go to the LLM / public REST (no email, no address)
const ORDER_FIELD_ALLOWLIST = [
  "order_id",
  "status",
  "order_status",
  "fulfillment_status",
  "payment_status",
  "payment_method",
  "total_amount",
  "total",
  "currency",
  "carrier",
  "tracking_number",
  "created_at",
  "updated_at",
  "customer_name",
  "customer",
  "items",
];

function safeOrder(order) {
  const out = {};
  for (const k of ORDER_FIELD_ALLOWLIST) {
    if (order[k] !== undefined && order[k] !== null && order[k] !== "")
      out[k] = order[k];
  }
  return out;
}

const pick = (obj, ...keys) => {
  for (const k of keys)
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  return null;
};

const NEXT_STEP = {
  PENDING:
    "Payment has not been confirmed, so check the payment status before anything else.",
  PAID: "Next, check whether the warehouse has started picking and packing it.",
  CAPTURED:
    "Next, check whether the warehouse has started picking and packing it.",
  PROCESSING:
    "Next, check whether the warehouse has handed the package to the carrier.",
  SHIPPED:
    "Next, check the carrier tracking information for the latest transit scan.",
  DELIVERED:
    "If the customer disputes delivery, verify the carrier's delivery scan.",
  COMPLETED: "No further fulfillment action is needed.",
  CANCELLED:
    "No further fulfillment action is needed; confirm any refund separately.",
  REFUNDED:
    "No further fulfillment action is needed; the customer should see the credit within the provider's window.",
};

// Status-style questions can be answered from the DB row alone — no LLM, ~ms latency.
const STATUS_INTENT =
  /\b(where|status|track|tracking|shipped|delivered|deliver|arrive|arrival|eta|stuck|update)\b/i;
const NOT_PLAIN_STATUS =
  /\b(refund|cancel|return|change|address|damaged|broken|defect|chargeback|ignore|instruction|prompt|system|reveal)\b/i;

const isPlainStatusQuery = (q) =>
  STATUS_INTENT.test(q) && !NOT_PLAIN_STATUS.test(q);

function buildFastOrderAnswer(order) {
  const status = String(
    pick(order, "fulfillment_status", "status", "order_status") || "UNKNOWN",
  ).toUpperCase();
  const payment = pick(order, "payment_status");
  const carrier = pick(order, "carrier");
  const tracking = pick(order, "tracking_number");

  let first = `Order ${order.order_id} is ${status}`;
  if (payment) first += ` (payment: ${String(payment).toUpperCase()})`;
  if (carrier || tracking) {
    first += ` via ${carrier || "carrier"}${tracking ? `, tracking ${tracking}` : ""}`;
  }
  first += ".";

  return `${first} ${NEXT_STEP[status] || "Verify the latest status in the order record."}`;
}

// ======================================================
// MCP TOOLS FOR OLLAMA  (get_order, list_orders, check_stock, search_products,
// update_stock)
//
// This is the ONLY way order/inventory data can reach the model when the
// fast-path above doesn't apply. The 5 tools are handed to Ollama as callable
// functions (same shape Ollama's function-calling expects); the model must
// invoke one to get real data — it is never fed a pre-written context block
// to paraphrase, and it has no other source of order/stock data to guess
// from. The actual tool logic lives in ../mcp/tools.js (createTools, bound
// to this backend's own pool above as `mcpTools`) and is shared byte-for-byte
// with the standalone mcp/ MCP server.
// ======================================================

const MCP_TOOLS_FOR_OLLAMA = [
  {
    type: "function",
    function: {
      name: "get_order",
      description:
        "Get full details of an order (header fields + line items) by its business order_id. " +
        "You MUST call this before stating any order's status, payment, carrier, tracking number, " +
        "total, or items — never answer those from memory or guess them.",
      parameters: {
        type: "object",
        properties: {
          order_id: {
            type: "string",
            description:
              "The order id/number the customer is asking about, e.g. '1001', 'ORD-1001', '#1001'.",
          },
        },
        required: ["order_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_orders",
      description:
        "List orders, optionally filtered by status (e.g. shipped, processing, delivered).",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description:
              "Optional status filter, e.g. 'shipped', 'processing', 'delivered'.",
          },
          limit: {
            type: "number",
            description: "Max rows to return (default 20, max 100).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_stock",
      description:
        "Check the current stock quantity and active status for a product by its SKU. " +
        "You MUST call this before stating whether a product is in stock — never guess.",
      parameters: {
        type: "object",
        properties: {
          sku: {
            type: "string",
            description: "The product SKU, e.g. 'SKU-001'.",
          },
        },
        required: ["sku"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_products",
      description:
        "Find a product by NAME (full or partial, case-insensitive) or by SKU, returning its price, " +
        "stock quantity and active status. Call this whenever the agent names a product without " +
        'giving a SKU (e.g. "USB-C Hub", "wireless mouse") or asks what something costs — ' +
        "never state a price, product name or availability from memory.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "The product name or partial name to look up, e.g. 'USB-C Hub', 'hub', 'mouse'; a SKU also works.",
          },
          limit: {
            type: "number",
            description: "Max products to return (default 10, max 50).",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_stock",
      description:
        "Adjust a product's stock by a signed delta (positive adds stock, negative removes stock). " +
        "Only call this when the agent explicitly asks to add or remove stock for a specific SKU — " +
        "never call it on your own initiative just because stock was discussed.",
      parameters: {
        type: "object",
        properties: {
          sku: {
            type: "string",
            description: "The product SKU, e.g. 'SKU-001'.",
          },
          quantity: {
            type: "number",
            description:
              "Signed integer delta. Positive adds stock, negative removes stock. Must not be 0.",
          },
        },
        required: ["sku", "quantity"],
      },
    },
  },
];

// Dispatches one Ollama tool_call to the matching mcpTools handler and
// normalizes the result back into plain JSON for the model to ground on.
// Never throws — a DB failure or unknown tool name still produces a
// groundable { error: ... } object instead of leaving the model to improvise.
async function callMcpTool(name, args, context = null) {
  // AUTHZ: a VERIFIED caller context ALWAYS wins — a logged-in web user must
  // never be widened to the service admin. The service account is only a
  // fallback for callers that sent no token at all (local/anonymous usage).
  // Both are re-verified against the DB per call, so revocation/expiry applies
  // immediately. Handlers fail closed when neither exists.
  const effective = context || (await getMcpServiceContext());

  let result;
  try {
    switch (name) {
      case "get_order":
        result = await mcpTools.getOrderHandler(args || {}, effective);
        break;
      case "list_orders":
        result = await mcpTools.listOrdersHandler(args || {}, effective);
        break;
      case "check_stock":
        result = await mcpTools.checkStockHandler(args || {}, effective);
        break;
      case "search_products":
        result = await mcpTools.searchProductsHandler(args || {}, effective);
        break;
      case "update_stock":
        result = await mcpTools.updateStockHandler(args || {}, effective);
        break;
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: `Tool "${name}" failed: ${e.message}` };
  }

  const text = result?.content?.[0]?.text || "";
  try {
    return JSON.parse(text);
  } catch (_e) {
    // Not JSON (e.g. a plain "Order not found: ..." message) — pass it through as-is.
    return { message: text, isError: Boolean(result?.isError) };
  }
}

// ======================================================
// ANSWER CACHE MANAGER
//   L1 memory (LRU+TTL)  ->  L2 PostgreSQL (query_cache table)
//   + single-flight coalescing, fail-open writes, hit counters
//
// NOTE: order-identified queries never reach this manager at all anymore —
// see answerQuery() below. This manager now only ever serves non-order,
// general knowledge / policy questions ("what's your return window", etc.).
// ======================================================

function normalizeQuery(q) {
  return String(q ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[?!.\s]+$/g, "")
    .trim();
}

// Queries containing an order id / tracking number / e-mail touch live personal data:
// they are cached with a short TTL instead of the long generic one.
const isLiveQuery = (norm) =>
  /\d/.test(norm) || norm.includes("@") || looksLikeCredentials(norm);

// ---------- semantic-cache word guard ----------
// A semantic hit must also share most of its CONTENT words with the matched
// question: cosine similarity alone matches "warranty period on the wireless
// mouse" against a cached "price of the wireless mouse" (~0.74) and would
// replay the price answer for a warranty question. False hits are worse than
// misses, so both gates must pass.
const SEMANTIC_STOP_WORDS = new Set([
  "the", "and", "for", "are", "was", "were", "been", "being", "with", "this",
  "that", "these", "those", "from", "into", "onto", "out", "off", "over",
  "under", "about", "does", "doing", "did", "has", "have", "had", "can",
  "could", "would", "should", "will", "shall", "may", "might", "must",
  "you", "your", "ours", "them", "their", "its", "our", "mine", "what",
  "which", "who", "whom", "how", "when", "where", "why", "who", "any",
  "all", "some", "most", "more", "than", "then", "there", "here", "please",
  "tell", "give", "show", "want", "need", "get", "got", "make", "made",
  "much", "many", "very", "just", "also", "still", "now", "today", "much",
  "cost", "price", "worth", "priced", "pay", "charge", "actually", "really",
  "remain", "available", "availability", "it", "is", "of", "to", "in", "on",
  "at", "by", "or", "if", "as", "a", "an", "be", "do", "i", "we", "me", "my",
]);

// "anon::question?::ctx1234abcd" -> "question" (strip scope + ctx fingerprint
// before comparing words, so cache-key plumbing never counts as content).
function semanticCompareText(storedQuery) {
  return String(storedQuery ?? "")
    .replace(/^(?:user:\d+|anon)::/, "")
    .replace(/::ctx[a-f0-9]+$/, "");
}

function stemWord(w) {
  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  if (w.endsWith("es") && w.length > 3) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) return w.slice(0, -1);
  if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 4) return w.slice(0, -2);
  return w;
}

function semanticWordScore(queryText, storedQuery) {
  const words = (text) =>
    new Set(
      semanticCompareText(text)
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .map((w) => w.replace(/^-+|-+$/g, ""))
        .filter((w) => w.length > 2 && !SEMANTIC_STOP_WORDS.has(w))
        .map(stemWord),
    );
  const a = words(queryText);
  const b = words(storedQuery);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.max(a.size, b.size);
}

function createCacheManager({ pool, promptVersion, logger = console }) {
  const l1 = new TTLCache(CACHE_L1_MAX);
  const inflight = new Map();

  const stats = {
    requests: 0,
    l1Hits: 0,
    dbHits: 0,
    semanticHits: 0,
    coalesced: 0,
    misses: 0,
    bypass: 0,
    dbWrites: 0,
    dbErrors: 0,
    writesQueued: 0,
    ollamaCalls: 0,
    embeddingsWritten: 0,
    avgMissMs: 0,
    avgHitMs: 0,
  };

  // Verbose per-layer cache chatter is OFF by default: the request tracer
  // (backend/trace.js) already reports every cache decision as one staged
  // console line, so the console stays a short list of steps per question.
  // Set LOG_VERBOSE=true to get the detailed [Cache] lines back.
  const verboseCacheLog =
    String(process.env.LOG_VERBOSE || "false").toLowerCase() === "true";

  const warn = (msg) => logger.warn(`[Cache] ${msg}`);
  const info = (msg) => {
    if (verboseCacheLog)
      (logger.log || console.log).call(logger, `[Cache] ${msg}`);
  };
  const short = (s) => String(s ?? "").slice(0, 80);
  const l1Key = (norm) => `v${promptVersion}:${sha(norm)}`;

  // An entry may never outlive the answer it holds: the in-memory TTL is capped
  // by the row's own remaining lifetime (and by the query's TTL on a write).
  // Without the cap a live query — digits/e-mail, cached for
  // CACHE_LIVE_TTL_SEC (60s) in L2 — kept being served from L1 for the full
  // CACHE_L1_TTL_SEC (300s), i.e. 4 minutes past its own expiry.
  function l1TtlMs({ expiresAt = null, ttlSec = CACHE_L1_TTL_SEC } = {}) {
    let ttlMs = Math.min(CACHE_L1_TTL_SEC, ttlSec) * 1000;

    const remainingMs = expiresAt
      ? new Date(expiresAt).getTime() - Date.now()
      : null;
    if (remainingMs !== null && Number.isFinite(remainingMs)) {
      ttlMs = Math.min(ttlMs, remainingMs);
    }

    return Math.max(0, ttlMs);
  }

  // Dedicated pooled client per cache call, with one retry after a TIMEOUT.
  // A client whose query was abandoned at the ceiling is DESTROYED
  // (release(err)) instead of returned to the pool: a half-finished wire
  // exchange would desync it and make every later query on that socket stall
  // (observed as repeated "query_cache.* timed out" bursts). Cold connects
  // (~12s locally) are absorbed by the retry, which lands on a fresh socket.
  async function cacheDb(run, label) {
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const client = await pool.connect();
      try {
        const result = await withTimeout(run(client), CACHE_DB_TIMEOUT_MS, label);
        client.release();
        dbReady = true;
        return result;
      } catch (e) {
        // An abandoned query poisons its client — never reuse it.
        client.release(e);
        lastError = e;
        // FIX: the retryable filter was /^timed out$/i only, so the designed
        // one-retry-on-a-warm-socket never fired for the pg-pool text
        // "Connection terminated due to connection timeout" (that is a
        // CONNECTION timeout, matching no "timed out" substring) and the
        // request failed outright after a single cold-connect miss.
        const retryable = /timed out|connection timeout|terminated/i.test(
          String(e?.message || ""),
        );
        if (!retryable || attempt >= 2) throw e;
        info(`${label} ${e.message} (attempt ${attempt}) — retrying on a fresh connection`);
      }
    }
    throw lastError;
  }

  // Pure read: a cache HIT must never write to the database (not even counters).
  async function dbGet(norm) {
    if (!CACHE_ENABLED || !databaseUrl) {
      info(
        `L2 read skipped (${CACHE_ENABLED ? "no database configured" : "cache disabled"})`,
      );
      return null;
    }
    try {
      const t0 = nowMs();
      const result = await cacheDb(
        (client) =>
          client.query(
            `SELECT query, answer, model, hits, created_at, expires_at
             FROM query_cache
            WHERE query_norm = $1
              AND prompt_version = $2
              AND expires_at > NOW()`,
            [norm, promptVersion],
          ),
        "query_cache.select",
      );
      dbReady = true;

      const row = result.rows[0];
      if (!row) return null;

      return { ...row, lookupMs: Number((nowMs() - t0).toFixed(1)) };
    } catch (e) {
      stats.dbErrors++;
      dbReady = false;
      warn(`L2 PostgreSQL read failed (serving live answer): ${e.message}`);
      return null;
    }
  }

  // SEMANTIC lookup: nearest neighbour by cosine similarity over pgvector.
  // Only consulted AFTER the exact-match read missed. Returns the row plus its
  // similarity (0..1), or null when nothing is close enough / embedding failed.
  async function dbSemanticGet(embedding) {
    if (!CACHE_ENABLED || !databaseUrl || !SEMANTIC_CACHE_ENABLED || !embedding)
      return null;
    try {
      const t0 = nowMs();
      const result = await cacheDb(
        (client) =>
          client.query(
            `SELECT query, answer, model, hits, created_at, expires_at,
                  1 - (embedding <=> $1::vector) AS similarity
             FROM query_cache
            WHERE prompt_version = $2
              AND expires_at > NOW()
              AND embedding IS NOT NULL
              AND (embedding_model = $3 OR SPLIT_PART(embedding_model, ':', 1) = SPLIT_PART($3, ':', 1))
            ORDER BY embedding <=> $1::vector
            LIMIT 1`,
            [toVectorLiteral(embedding), promptVersion, EMBED_MODEL],
          ),
        "query_cache.semantic",
      );
      dbReady = true;

      const row = result.rows[0];
      const similarity = row ? Number(row.similarity) : 0;
      if (
        !row ||
        !Number.isFinite(similarity) ||
        similarity < SEMANTIC_MIN_SIMILARITY
      )
        return null;

      return {
        ...row,
        similarity: Number(similarity.toFixed(4)),
        lookupMs: Number((nowMs() - t0).toFixed(1)),
      };
    } catch (e) {
      stats.dbErrors++;
      dbReady = false;
      warn(`semantic lookup failed (serving live answer): ${e.message}`);
      return null;
    }
  }

  // PENDING-WRITE FLUSHER — a cache MISS must never lose its answer row.
  // When the Postgres connection wedges at write time (observed on this setup:
  // after an idle pool, new connects can stall for the full connect timeout
  // under CPU load), the row is queued and retried on a timer until it lands
  // or the row's own TTL expires. Entries are keyed by query_norm so a re-ask
  // never duplicates them.
  const pendingWrites = new Map(); // norm -> { row, expires, attempts }
  let flushTimer = null;

  function scheduleWriteFlush(delayMs = 10000) {
    if (flushTimer) return;
    flushTimer = setTimeout(runWriteFlush, delayMs);
    flushTimer.unref?.();
  }

  async function runWriteFlush() {
    flushTimer = null;
    for (const [norm, entry] of [...pendingWrites.entries()]) {
      if (entry.expires <= Date.now()) {
        pendingWrites.delete(norm);
        warn(`pending write dropped for "${short(norm)}" (TTL expired before DB recovered)`);
        continue;
      }
      const ok = await dbPutRaw(entry.row);
      if (ok) {
        pendingWrites.delete(norm);
        info(`pending write flushed for "${short(norm)}" (attempt ${entry.attempts + 1})`);
      } else if (++entry.attempts >= 10) {
        pendingWrites.delete(norm);
        warn(`pending write dropped for "${short(norm)}" (10 failed attempts)`);
      }
    }
    if (pendingWrites.size) scheduleWriteFlush();
  }

  // Raw upsert — one bounded attempt per call (cacheDb already retries a
  // timed-out connection once on a fresh socket). Never throws.
  async function dbPutRaw({
    norm,
    query,
    answer,
    model,
    ttlSec,
    latencyMs,
    embedding,
  }) {
    if (!CACHE_ENABLED || !databaseUrl) return false;
    try {
      await cacheDb((client) => client.query(
        `INSERT INTO query_cache (query_norm, query, answer, model, prompt_version, latency_ms, created_at, expires_at, embedding, embedding_model)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW() + ($7 || ' seconds')::interval, $8::vector, $9)
           ON CONFLICT (query_norm) DO UPDATE
             SET answer = EXCLUDED.answer,
                 query = EXCLUDED.query,
                 model = EXCLUDED.model,
                 prompt_version = EXCLUDED.prompt_version,
                 latency_ms = EXCLUDED.latency_ms,
                 created_at = NOW(),
                 expires_at = EXCLUDED.expires_at,
                 embedding = EXCLUDED.embedding,
                 embedding_model = EXCLUDED.embedding_model`,
        [
          norm,
          query,
          answer,
          model,
          promptVersion,
          latencyMs ?? null,
          String(ttlSec),
          embedding ? toVectorLiteral(embedding) : null,
          embedding ? EMBED_MODEL : null,
        ],
      ), "query_cache.upsert");
      dbReady = true;
      stats.dbWrites++;
      if (embedding) stats.embeddingsWritten++;
      return true;
    } catch (e) {
      stats.dbErrors++;
      dbReady = false;
      warn(`L2 PostgreSQL write-back failed: ${e.message}`);
      return false;
    }
  }

  // Public write path: try once immediately; on failure QUEUE the row for the
  // flusher instead of dropping it. Returns true only when the row actually
  // reached the database, so callers can report "stored" honestly.
  async function dbPut(row) {
    if (!CACHE_ENABLED) {
      info(`cache write skipped for "${short(row.norm)}" (cache disabled)`);
      return false;
    }
    if (!databaseUrl) {
      info(`cache write skipped for "${short(row.norm)}" (no database configured)`);
      return false;
    }
    if (await dbPutRaw(row)) return true;

    if (pendingWrites.size >= 500) {
      const oldest = pendingWrites.keys().next().value;
      pendingWrites.delete(oldest);
    }
    pendingWrites.set(row.norm, {
      row,
      expires: Date.now() + row.ttlSec * 1000,
      attempts: 0,
    });
    stats.writesQueued++;
    info(`cache write queued for retry "${short(row.norm)}" (pending ${pendingWrites.size})`);
    scheduleWriteFlush();
    return false;
  }

  // Fire-and-forget audit row in `queries`.
  // Called ONLY for genuine MISSes — a cache hit must never write to the database.
  // One row per distinct query (upsert), so a re-answer updates the row instead of
  // inserting a duplicate.
  function auditLog({ query, answer, model, latencyMs }) {
    if (!databaseUrl) return;
    pool
      .query(
        `INSERT INTO queries (query, answer, model, cached, latency_ms)
       VALUES ($1, $2, $3, FALSE, $4)
       ON CONFLICT (query) DO UPDATE
         SET answer = EXCLUDED.answer,
             model = EXCLUDED.model,
             latency_ms = EXCLUDED.latency_ms`,
        [query, answer, model, latencyMs ?? null],
      )
      .catch(() => {});
  }

  const hitResult = (row, layer, lookupMs) => ({
    answer: row.answer,
    model: row.model || "cache",
    usage: null,
    cache: {
      layer,
      hit: true,
      query: row.query,
      hits: row.hits ?? 0,
      lookupMs,
    },
  });

  function recordHitTime(ms) {
    stats.avgHitMs = stats.avgHitMs
      ? Number(((stats.avgHitMs + ms) / 2).toFixed(1))
      : Number(ms.toFixed(1));
  }

  function recordMissTime(ms) {
    stats.avgMissMs = stats.avgMissMs
      ? Number(((stats.avgMissMs + ms) / 2).toFixed(1))
      : Number(ms.toFixed(1));
  }

  /**
   * @param {string} query
   * @param {(onDelta?: (chunk: string) => void) => Promise<object>} compute
   * @param {{onDelta?: (chunk: string) => void, onStored?: (info: object) => void}} opts
   */
  async function resolve(query, compute, opts = {}) {
    stats.requests++;
    const startedAt = nowMs();
    const norm = normalizeQuery(query);
    const trace = opts.onTrace;

    if (!CACHE_ENABLED || !norm) {
      stats.bypass++;
      info(
        `BYPASS  "${short(norm)}" (cache ${CACHE_ENABLED ? "has no normalized query" : "disabled"})`,
      );
      trace?.({
        stage: "cache",
        status: "skip",
        title: "Cache bypassed",
        detail: CACHE_ENABLED ? "empty normalized query" : "cache disabled",
      });
      const result = await compute(opts.onDelta);
      return {
        ...result,
        cache: {
          layer: "BYPASS",
          hit: false,
          embeddingStatus: "SKIPPED",
          semanticStatus: "SKIPPED",
        },
      };
    }

    const ttlSec = isLiveQuery(norm) ? CACHE_LIVE_TTL_SEC : CACHE_TTL_SEC;
    const key = l1Key(norm);

    // ---------- L1: memory (no database access at all) ----------
    const memory = l1.get(key);
    if (memory) {
      stats.l1Hits++;
      const ms = Number((nowMs() - startedAt).toFixed(1));
      recordHitTime(ms);
      info(`L1_MEMORY  "${short(norm)}" (${ms}ms, no DB read/write)`);
      trace?.({
        stage: "cache",
        status: "ok",
        title: "L1 memory hit",
        detail: `served in ${ms}ms · no DB, no LLM`,
      });
      const result = hitResult(memory, "L1_MEMORY", ms);
      // No audit row: cache hits must not write to the database.
      // L1 served it from the in-process map — no embed call, no semantic lookup.
      return {
        ...result,
        cache: {
          ...result.cache,
          hitMs: ms,
          embeddingStatus: "SKIPPED",
          semanticStatus: "SKIPPED",
        },
      };
    }

    // ---------- single-flight: one in-flight resolution per cache key ----------
    // The leader below owns the L2 read AND the MISS compute, and it is registered
    // in `inflight` before its first await. Concurrent identical requests therefore
    // always join it instead of racing into a second L2 read / LLM call / write.
    if (inflight.has(key)) {
      stats.coalesced++;
      info(
        `COALESCED  "${short(norm)}" (joined in-flight request, no LLM call)`,
      );
      trace?.({
        stage: "cache",
        status: "skip",
        title: "Joined an in-flight request",
        detail: "identical query already generating · no second LLM call",
      });
      const shared = await inflight.get(key);
      const ms = Number((nowMs() - startedAt).toFixed(1));
      recordHitTime(ms);
      // Joined an in-flight leader request: the leader already handled the
      // embed call / semantic lookup, so there is nothing new to report here.
      return {
        ...shared,
        cache: {
          layer: "COALESCED",
          hit: true,
          hitMs: ms,
          embeddingStatus: "SHARED",
          semanticStatus: "SHARED",
        },
      };
    }

    const promise = (async () => {
      // Generate the embedding for the semantic cache lookup. Contextual
      // queries (a previous-3-request conversation history exists) are
      // embedded NEVER: the embedding of a bare follow-up cannot represent
      // its conversation context, so a semantic hit could replay an answer
      // that was computed against DIFFERENT history — exactly the wrong
      // context bug the history-fingerprinted cache keys exist to prevent.
      // opts.embedText keeps the scope/ctx prefixes ("anon::…::ctx…") out of
      // the vector text so cache rows embed the user's actual question.
      const embedding =
        SEMANTIC_CACHE_ENABLED && !opts.skipEmbedding
          ? await embedQuery(opts.embedText || norm)
          : null;

      // CONSOLE MESSAGE #1 — embedding cache: did we get an embedding to search with?
      // HIT  = embedding generated successfully via Ollama, ready to use for lookup.
      // MISS = embed call failed/returned nothing (embedQuery() already warned why);
      //        the semantic tier below is skipped for this request.
      // SKIPPED (contextual) = conversation history present for this request;
      //        the exact-match history-fingerprinted cache still applies.
      const embeddingStatus = SEMANTIC_CACHE_ENABLED
        ? embedding
          ? "HIT"
          : opts.skipEmbedding
            ? "SKIPPED"
            : "MISS"
        : "SKIPPED";
      if (SEMANTIC_CACHE_ENABLED) {
        info(
          embedding
            ? `EMBEDDING CACHE: HIT  "${short(norm)}" (${EMBED_MODEL}, ${embedding.length}d)`
            : opts.skipEmbedding
              ? `EMBEDDING CACHE: SKIPPED "${short(norm)}" (contextual query — no semantic matching over conversation history)`
              : `EMBEDDING CACHE: MISS "${short(norm)}" (no embedding available)`,
        );
      }

      // ---------- L2: PostgreSQL persistent cache (read only) ----------
      const dbRow = await dbGet(norm);
      if (dbRow) {
        stats.dbHits++;
        const ttlMs = l1TtlMs({ expiresAt: dbRow.expires_at });
        if (ttlMs > 0) l1.set(key, dbRow, ttlMs);
        const ms = Number((nowMs() - startedAt).toFixed(1));
        recordHitTime(ms);
        info(
          `L2_POSTGRES  "${short(norm)}" (lookup ${dbRow.lookupMs}ms, no write)`,
        );
        trace?.({
          stage: "cache",
          status: "ok",
          title: "L2 PostgreSQL exact hit",
          detail: `lookup ${dbRow.lookupMs}ms · no LLM`,
        });
        const result = hitResult(dbRow, "L2_POSTGRES", dbRow.lookupMs);
        // Cache HIT: Embedding generated for lookup, but NOT stored in DB.
        // Exact match found -> semantic tier is short-circuited, never reached.
        return {
          ...result,
          cache: {
            ...result.cache,
            hitMs: ms,
            sourceTable: "query_cache",
            embeddingStatus,
            semanticStatus: "NOT_CHECKED",
          },
        };
      }

      // ---------- L2_SEMANTIC: nearest cached query by cosine similarity ----------
      // Skipped for live queries (order id / tracking / e-mail): two DIFFERENT
      // order numbers embed nearly identically, and a semantic hit would then
      // answer the wrong order. Rephrased generic questions are what this tier
      // is for. Also skipped for contextual queries (skipEmbedding → no
      // embedding) — a semantic hit must never replay an answer that was
      // generated with different conversation history.
      let semanticStatus = "SKIPPED"; // overwritten below whenever the tier actually runs
      if (
        SEMANTIC_CACHE_ENABLED &&
        !isLiveQuery(norm) &&
        embedding &&
        !opts.skipEmbedding
      ) {
        let semRow = await dbSemanticGet(embedding);

        // WORD GUARD: similarity alone can match a question about a different
        // attribute of the same product (warranty vs price — 0.74 measured).
        // A false hit replays a wrong answer, so the content-word overlap must
        // clear SEMANTIC_MIN_WORD_MATCH too.
        if (semRow) {
          const wordScore = semanticWordScore(
            opts.embedText || norm,
            semRow.query,
          );
          if (wordScore < SEMANTIC_MIN_WORD_MATCH) {
            info(
              `SEMANTIC CACHE: REJECTED "${short(norm)}" ~ "${short(semRow.query)}" (similarity ${semRow.similarity} ok, but word overlap ${wordScore.toFixed(2)} < ${SEMANTIC_MIN_WORD_MATCH})`,
            );
            semRow = null;
          }
        }

        // CONSOLE MESSAGE #2 — semantic cache: did the embedding match an
        // existing cached answer (above SEMANTIC_MIN_SIMILARITY)?
        info(
          semRow
            ? `SEMANTIC CACHE: HIT  "${short(norm)}" ~ "${short(semRow.query)}" (similarity ${semRow.similarity}, lookup ${semRow.lookupMs}ms)`
            : `SEMANTIC CACHE: MISS "${short(norm)}" (no match >= ${SEMANTIC_MIN_SIMILARITY} similarity + word overlap)`,
        );

        if (semRow) {
          stats.semanticHits++;
          trace?.({
            stage: "cache",
            status: "ok",
            title: "L2 semantic hit",
            detail: `similarity ${semRow.similarity} · matched "${short(semRow.query)}"`,
          });
          const ttlMs = l1TtlMs({ expiresAt: semRow.expires_at });
          if (ttlMs > 0) l1.set(key, semRow, ttlMs);
          const ms = Number((nowMs() - startedAt).toFixed(1));
          recordHitTime(ms);
          // Cache HIT: Embedding generated for lookup, but NOT stored in DB.
          return {
            answer: semRow.answer,
            model: semRow.model || "cache",
            usage: null,
            cache: {
              layer: "L2_SEMANTIC",
              hit: true,
              query: semRow.query,
              hits: semRow.hits ?? 0,
              lookupMs: semRow.lookupMs,
              similarity: semRow.similarity,
              hitMs: ms,
              sourceTable: "query_cache",
              embeddingStatus,
              semanticStatus: "HIT",
            },
          };
        }
        // Fall through to MISS below, carrying semanticStatus = "MISS" (checked, no match).
        semanticStatus = "MISS";
      } else if (SEMANTIC_CACHE_ENABLED && isLiveQuery(norm)) {
        info(
          `SEMANTIC CACHE: SKIPPED "${short(norm)}" (live query — order id/tracking/email, never semantically matched)`,
        );
      }

      // ---------- MISS: Ollama (the only path that writes to the cache) ----------
      stats.misses++;
      stats.ollamaCalls++;
      info(`MISS  "${short(norm)}" -> LLM`);
      trace?.({
        stage: "cache",
        status: "skip",
        title: "Cache miss",
        detail: "generating with the model",
      });

      const result = await compute(opts.onDelta);
      const elapsed = Number((nowMs() - startedAt).toFixed(1));
      recordMissTime(elapsed);

      let stored = false;
      if (result?.answer) {
        l1.set(
          key,
          { answer: result.answer, model: result.model, query, hits: 0 },
          l1TtlMs({ ttlSec }),
        );
        // Cache MISS: Store response and embedding in DB.
        stored = await dbPut({
          norm,
          query,
          answer: result.answer,
          model: result.model,
          ttlSec,
          latencyMs: elapsed,
          embedding,
        });
        if (stored) {
          info(
            `WRITE  "${short(norm)}" -> query_cache (ttl ${ttlSec}s, miss ${elapsed}ms)`,
          );
          trace?.({
            stage: "cache",
            status: "ok",
            title: "Answer cached",
            detail: `query_cache · ttl ${ttlSec}s`,
          });
        }
      } else {
        info(`SKIP_WRITE  "${short(norm)}" (empty answer)`);
      }

      auditLog({
        query,
        answer: result.answer,
        model: result.model,
        latencyMs: elapsed,
      });
      opts.onStored?.({ norm, ttlSec, latencyMs: elapsed, stored });

      return {
        ...result,
        cache: {
          layer: "MISS",
          hit: false,
          latencyMs: elapsed,
          stored,
          ttlSec,
          store: stored ? "query_cache" : null,
          embeddingStatus,
          semanticStatus,
        },
      };
    })();

    inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      inflight.delete(key);
    }
  }

  // Backfills embeddings for rows written BEFORE the semantic tier existed
  // (they were stored with embedding = NULL). Bounded and fail-open.
  async function backfillEmbeddings({ limit = 500 } = {}) {
    if (!databaseUrl || !SEMANTIC_CACHE_ENABLED)
      return { scanned: 0, embedded: 0, skipped: true };
    let scanned = 0;
    let embedded = 0;
    try {
      const pending = await pool.query(
        `SELECT query_norm, query FROM query_cache
          WHERE embedding IS NULL
          ORDER BY created_at DESC
          LIMIT $1`,
        [limit],
      );
      scanned = pending.rows.length;
      for (const row of pending.rows) {
        const vec = await embedQuery(row.query);
        if (!vec) continue;
        await pool.query(
          `UPDATE query_cache
              SET embedding = $2::vector, embedding_model = $3
            WHERE query_norm = $1`,
          [row.query_norm, toVectorLiteral(vec), EMBED_MODEL],
        );
        embedded++;
      }
    } catch (e) {
      warn(`embedding backfill failed: ${e.message}`);
    }
    return { scanned, embedded, skipped: false };
  }

  async function flush({ memory = true, database = true } = {}) {
    if (memory) l1.clear();
    let deleted = 0;
    if (database && databaseUrl) {
      try {
        const r = await pool.query("DELETE FROM query_cache");
        deleted = r.rowCount || 0;
      } catch (e) {
        warn(`flush failed: ${e.message}`);
      }
    }
    return { clearedMemory: memory, deletedRows: deleted };
  }

  function getStats() {
    const served = stats.l1Hits + stats.dbHits + stats.coalesced;
    const cacheable = served + stats.misses;
    return {
      ...stats,
      hitRate: cacheable ? Number((served / cacheable).toFixed(3)) : 0,
      l1Size: l1.size,
      inFlight: inflight.size,
      pendingWrites: pendingWrites.size,
      config: {
        enabled: CACHE_ENABLED,
        l1TtlSec: CACHE_L1_TTL_SEC,
        l1Max: CACHE_L1_MAX,
        genericTtlSec: CACHE_TTL_SEC,
        liveTtlSec: CACHE_LIVE_TTL_SEC,
        table: "query_cache",
        promptVersion,
        semantic: {
          enabled: SEMANTIC_CACHE_ENABLED,
          model: EMBED_MODEL,
          dim: EMBED_DIM,
          minSimilarity: SEMANTIC_MIN_SIMILARITY,
        },
      },
    };
  }

  return {
    resolve,
    flush,
    getStats,
    backfillEmbeddings,
    clearMemory: () => l1.clear(),
  };
}

const cacheManager = createCacheManager({
  pool,
  promptVersion: PROMPT_VERSION,
});

// ======================================================
// ANSWER PIPELINE  (shared by HTTP + WebSocket)
// ======================================================

// ======================================================
// SCOPE GATE  (FIX #3 — e-commerce support + greetings ONLY, never general chat)
// ======================================================

// Support domain: a query carrying one of these keywords stays in-domain and
// reaches the normal pipeline (fast-path / cache / Ollama with the MCP tools).
//
// The list is deliberately generous about product/price wording. A user writes
// "prize", "cost" or "how much" as readily as "price", and every one of those
// used to be bounced by this gate to the OUT_OF_SCOPE canned reply — even
// though the catalog and the search_products tool could answer instantly
// ("what is prize of Wireless Mouse" was declined; only the word "product"
// saved "...prize of product name USB-C Hub" from the same fate).
const ECOMMERCE_KEYWORDS_RE =
  /\b(order|orders|ordered|refund|refunds|refunded|return|returns|exchange|shipping|shipment|ship|delivery|deliver|delivered|tracking|track|transit|package|parcel|invoice|receipt|payment|payments|paid|purchase|purchases|buy|checkout|cancel|cancelled|canceled|stock|stocks|inventory|price|prices|pricing|priced|prize|prizes|cost|costs|worth|charge|charges|discount|discounts|coupon|coupons|sale|sales|offer|offers|product|products|item|items|sku|catalog|cart|account|subscription|warranty|support|help|available|availability|cheap|cheaper|cheapest|expensive)\b/i;

// "SKU-003" / "sku 12" — a product reference that carries no keyword above
// ("what does SKU-003 cost" still has to reach the catalog).
const SKU_REFERENCE_RE = /\bsku[-_\s]?\d/i;

// "how much is / does ..." — the usual phrasing of a price question.
const HOW_MUCH_RE = /\bhow much\b/i;

// Small talk: answered with a fixed line, no LLM call. Anchored to the whole
// query (plus trailing punctuation) so "hi" inside a word like "this" never
// takes the greeting path.
const GREETING_RE =
  /^\s*(?:hi+|hey+|hello+|howdy|yo|hiya|good\s+(?:morning|afternoon|evening|day)|how\s+are\s+you|what'?s\s+up|thanks?|thank\s+you|thx|bye+|goodbye|see\s+ya|later|ok(?:ay)?)(?:\s+(?:there|team|folks|everyone|friend|again))?[\s.!?]*$/i;

const GREETING_ANSWER =
  "Hi! I'm OpsMate, the e-commerce support assistant. Ask me about an order, a refund, shipping, payments, or your account.";

const OUT_OF_SCOPE_ANSWER =
  "I'm OpsMate, an e-commerce support assistant, so I can only help with orders, refunds, shipping, payments, and account questions. Please ask about one of those topics.";

// --------------------------------------------------------------------------
// CREDENTIAL GUARD (security): users sometimes paste email + password into
// the chat box thinking OpsMate can log them in. Two problems with that:
//   1. Credentials must NEVER reach the LLM prompt, the answer cache, or the
//      query logs — anything the model sees can be echoed back, and log files
//      are read by more people than the chat is. This gate runs FIRST, so a
//      credential-shaped message is answered with a fixed canned reply and
//      its text is REDACTED before logging.
//   2. Chat cannot log you in by design: sessions are issued only by the
//      verified /api/auth/login endpoint. The reply points the user there.
// --------------------------------------------------------------------------
const CREDENTIALS_ANSWER =
  "I noticed you sent email/password details. For your safety I've ignored them — never share your password in chat." +
  " Please use the 'Sign in / create account' button at the top of this page to log in.";

// Matches "password: X", "password = X", "pass Aakash@159", "login in please, email : ...",
// with or without separators between the field word and the value.
const CREDENTIAL_RE =
  /\b(pass(word)?|pwd|passcode)\s*[:=]?\s*\S|\b(email\s*[:=])\b.*\b(pass(word)?|pwd)\b|\blog\s*in\b.*\b(email|password|pwd)\b/i;

function looksLikeCredentials(query) {
  return CREDENTIAL_RE.test(String(query ?? ""));
}

// Replaces anything that looks like a credential VALUE with ******** so the
// console/logQuery line never contains the user's real password or email.
function redactCredentials(query) {
  return String(query ?? "")
    .replace(
      /\b(pass(word)?|pwd|passcode)\s*[:=]?\s*[^,;\n]+/gi,
      "password: ********",
    )
    .replace(/\b(email)\s*[:=]\s*[^,;\n]+/gi, "email: ********");
}

// Order IDs and support keywords always win over a greeting match, so
// "hi, what's the status of order 1002" is routed as ECOMMERCE, not GREETING.
function classifyQueryScope(query) {
  const q = String(query ?? "").trim();
  if (!q) return "OUT_OF_SCOPE";
  if (
    extractOrderId(q) ||
    SKU_REFERENCE_RE.test(q) ||
    HOW_MUCH_RE.test(q) ||
    ECOMMERCE_KEYWORDS_RE.test(q)
  ) {
    return "ECOMMERCE";
  }
  if (GREETING_RE.test(q)) return "GREETING";
  return "OUT_OF_SCOPE";
}

// Runs only on cache MISS / BYPASS. Streams deltas through onDelta when provided.
//
// Two ways an order question gets answered, and NEITHER lets the model guess:
//   1. Fast path   — plain "what's the status" question with a recognizable
//                     order id: answered straight from Postgres via
//                     lookupOrder(), templated, ZERO LLM involvement.
//   2. Tool path   — anything else (refund questions, "when will it arrive",
//                     stock questions, list-orders requests, no order id yet,
//                     etc.): handed to Ollama WITH the 5 MCP tools. The model
//                     must call a tool to get real data; it is never fed a
//                     pre-built context block, so there is nothing for it to
//                     paraphrase except the tool's actual DB output.
async function generateAnswer(
  query,
  onDelta,
  history = [],
  signal,
  trace,
  context = null,
) {
  const orderId = extractOrderId(query);

  if (ORDER_FAST_PATH && orderId && isPlainStatusQuery(query)) {
    trace?.({
      stage: "route",
      title: "Order fast-path",
      detail: `${orderId} · direct SQL, no LLM`,
    });

    // Same ownership rule as the MCP order tools: a verified user is scoped
    // to their own rows, an admin (or the fallback service account) sees all.
    const ownerUserId = orderOwnerUserId(
      context,
      context ? null : await getMcpServiceContext(),
    );

    let order; // undefined = DB failed, null = not found, object = found
    try {
      order = await lookupOrder(orderId, ownerUserId);
    } catch (e) {
      console.error("[Order] lookup failed:", e.message);
    }

    // CAUTION: order === null means "no row for THIS caller" (wrong owner or
    // unknown id) — templated, non-committal, exactly like the MCP get_order
    // tool, so nothing leaks whether the order exists under someone else.
    // order === undefined means the DB read itself failed (fall through below).
    if (order !== undefined) {
      const status = order
        ? String(
            pick(order, "fulfillment_status", "status", "order_status") ||
              "unknown",
          ).toUpperCase()
        : null;

      trace?.({
        stage: "tool",
        status: order ? "ok" : "error",
        title: order ? "PostgreSQL order lookup" : "Order not found",
        detail: order
          ? `${order.order_id} · ${status.toLowerCase()}`
          : `${orderId} · no row for this caller · templated reply, no LLM`,
      });

      const answer = order
        ? buildFastOrderAnswer(order)
        : `I could not find order ${orderId} in the orders database. Please verify the order ID with the customer.`;
      if (onDelta) onDelta(answer);
      return {
        answer,
        model: "order-fast-path (postgres, no LLM)",
        usage: null,
        usedTool: true,
        tool: "get_order (SQL fast-path)",
        source: "postgres",
      };
    }
    // order lookup itself failed (DB down) — fall through to the tool path,
    // which will hit the same failure and surface it through the MCP tool's
    // { error: ... } shape instead of silently guessing.
  }

  return askOllamaWithOrderTool(query, {
    onDelta,
    history,
    signal,
    trace,
    context,
  });
}

// FIX #2: order-identified queries completely bypass the cache manager (L1, L2,
// and the semantic tier) and always call generateAnswer() fresh. Order status
// is live data — serving it from a 60s-TTL cache risks staleness, and WORSE,
// a single bad LLM guess getting cached would keep replaying that same wrong
// answer to every identical follow-up question (this is exactly what happened
// before this fix). The fast-path inside generateAnswer() already makes this
// a sub-millisecond Postgres read in the common case, so skipping the cache
// costs nothing.
function cannedResult(answer, layer, onDelta) {
  if (onDelta) onDelta(answer);
  return Promise.resolve({
    answer,
    model: "scope-gate (no LLM)",
    usage: null,
    cache: {
      layer,
      hit: false,
      embeddingStatus: "SKIPPED",
      semanticStatus: "SKIPPED",
    },
  });
}

const answerQuery = (query, opts) => {
  // Per-request pipeline trace: one concise console line per step, and the very
  // same step streamed to the UI while the request is still running.
  const trace = opts?.onTrace;

  // ---------- credential guard: run BEFORE everything (scope gate, cache,
  // LLM) so credentials can never leak into a model prompt or cached answer ----------
  if (looksLikeCredentials(query)) {
    trace?.({
      stage: "route",
      title: "Credential guard",
      detail:
        "credentials ignored, safe reply · no LLM, no cache, redacted in logs",
    });
    return cannedResult(CREDENTIALS_ANSWER, "CREDENTIALS", opts?.onDelta);
  }

  const scope = classifyQueryScope(query);
  const orderId = extractOrderId(query);

  trace?.({
    stage: "understand",
    title: "Query understood",
    detail: orderId
      ? `order question · ${orderId}`
      : scope === "GREETING"
        ? "greeting"
        : scope === "OUT_OF_SCOPE"
          ? "outside support scope"
          : "support question · no order id",
  });

  // ---------- scope gate: never let Ollama see a greeting or an off-topic
  // question, so it has zero opportunity to guess/hallucinate outside the
  // e-commerce support domain ----------
  if (scope === "GREETING") {
    trace?.({
      stage: "route",
      title: "Greeting handler",
      detail: "canned reply · no LLM, no cache",
    });
    return cannedResult(GREETING_ANSWER, "GREETING", opts?.onDelta);
  }
  if (scope === "OUT_OF_SCOPE") {
    trace?.({
      stage: "route",
      title: "Scope gate declined",
      detail: "canned reply · no LLM, no cache",
    });
    return cannedResult(OUT_OF_SCOPE_ANSWER, "OUT_OF_SCOPE", opts?.onDelta);
  }

  if (orderId) {
    trace?.({
      stage: "route",
      title: "Cache bypassed",
      detail: "order data is live — always fresh from the DB",
    });

    return generateAnswer(
      query,
      opts?.onDelta,
      opts?.history || [],
      opts?.signal,
      trace,
      opts?.context,
    ).then((result) => ({
      ...result,
      cache: {
        layer: "BYPASS_ORDER",
        hit: false,
        reason: "order-identified query: always fresh from DB",
        embeddingStatus: "SKIPPED",
        semanticStatus: "SKIPPED",
      },
    }));
  }

  // FIX: order-identified queries with caller context must never be cached under an
  // owner-prefixed key (`user:<id>::...`): a different caller asking the same normalized
  // text would receive that caller's cached answer (the BUG-01 cross-user poisoning the
  // owner prefix was meant to prevent). They bypass the cache and call generateAnswer()
  // directly, tagged BYPASS_ORDER. This mirrors what the block above already does for
  // order queries without context, and reuses the top-level resolveAnswer().
  if (opts?.context && extractOrderId(query)) {
    return resolveAnswer(query, opts);
  }

  // Context-aware cache key: the previous N requests (sanitized as the last 3
  // complete turns) are fingerprinted into the key, so the SAME question text
  // asked in DIFFERENT conversations can never collide. A cached answer must
  // always match BOTH the question and the conversation context it was
  // generated with. Standalone questions (no history) keep the history-free
  // key, so unrelated sessions still share the generic cache.
  const historyFp = historyFingerprint(opts?.history || [], query);

  trace?.({
    stage: "understand",
    title: "Context window",
    detail: historyFp
      ? `last ${MAX_CONVERSATION_TURNS} turn(s) attached · ctx ${historyFp.slice(0, 6)}`
      : "standalone question · no history attached",
  });

  return cacheManager.resolve(
    // Keep cached answers scoped to the caller's identity AND their
    // conversation context (previous 3 requests).
    `${
      opts?.context ? `user:${opts.context.userId}` : "anon"
    }::${query}${historyFp ? `::ctx${historyFp}` : ""}`,
    (onDelta) =>
      generateAnswer(
        query,
        onDelta,
        opts?.history || [],
        opts?.signal,
        trace,
        opts?.context,
      ),
    // Contextual requests skip the embedding/semantic tier entirely (see the
    // resolve() comment: a bare follow-up question cannot be semantically
    // matched without risking a wrong-context replay), and embed the raw
    // question text so cached vectors never contain cache-key prefixes.
    { ...opts, historyFp, embedText: query, skipEmbedding: Boolean(historyFp) },
  );
};

// Cache-bypass path for order-identified queries that carry a caller context.
// Top-level because module.exports references it and answerQuery() calls it.
async function resolveAnswer(query, opts = {}) {
  const trace = opts?.trace;

  trace?.({
    stage: "cache",
    status: "skip",
    title: "Cache bypassed",
    detail:
      "order-identified query with caller context — never cached under an owner key",
  });

  const result = await generateAnswer(
    query,
    opts?.onDelta,
    opts?.history || [],
    opts?.signal,
    trace,
    opts?.context,
  );

  return {
    ...result,
    cache: {
      layer: "BYPASS_ORDER",
      hit: false,
      reason: "order-identified query with caller context",
      embeddingStatus: "SKIPPED",
      semanticStatus: "SKIPPED",
    },
  };
}

// ======================================================
// USER-FACING ERROR MAPPING
// ======================================================

const FRIENDLY_ERRORS = {
  OLLAMA_UNAVAILABLE: {
    status: 503,
    title: "Ollama is not running",
    message: `Could not reach Ollama at ${ollamaHost}. Start it with "ollama serve" and try again.`,
  },
  MODEL_NOT_FOUND: {
    status: 503,
    title: "Ollama model missing",
    message: `The model "${ollamaModel}" is not installed. Run "ollama pull ${ollamaModel}" and try again.`,
  },
  RATE_LIMITED: {
    status: 429,
    title: "Rate limit reached",
    message:
      "Too many AI requests were sent in a short time. Wait a few seconds, then try again.",
  },
  AI_TIMEOUT: {
    status: 504,
    title: "Ollama response timed out",
    message: "The local model took too long to respond. Please try again.",
  },
  AUTH_ERROR: {
    status: 401,
    title: "Provider rejected the request",
    message: "The AI provider rejected the request configuration.",
  },
  AI_PROVIDER_UNAVAILABLE: {
    status: 503,
    title: "No AI provider available",
    message:
      "Ollama is the configured provider and it is not reachable right now.",
  },
  PROVIDER_UNAVAILABLE: {
    status: 503,
    title: "AI provider unavailable",
    message:
      "The AI provider is having issues right now. Please try again in a few minutes.",
  },
  DB_UNAVAILABLE: {
    status: 503,
    title: "Orders database unavailable",
    message:
      "The orders database is not responding right now. Please try again in a moment.",
  },
  AI_REQUEST_FAILED: {
    status: 500,
    title: "AI request failed",
    message: "The model could not answer right now. Please try again.",
  },
  CLIENT_ABORTED: {
    status: 499,
    title: "Request stopped",
    message: "Generation was stopped.",
  },
};

function resolveErrorCode(error) {
  if (error?.code && FRIENDLY_ERRORS[error.code]) return error.code;

  const message = String(error?.message || "");
  if (/ECONNREFUSED|fetch failed|not reachable/i.test(message))
    return "OLLAMA_UNAVAILABLE";
  if (
    /not installed|try pulling|no such model|model .*not found/i.test(message)
  )
    return "MODEL_NOT_FOUND";
  if (error?.status === 429 || /rate limit|too many requests/i.test(message))
    return "RATE_LIMITED";
  if (error?.status === 401 || error?.status === 403) return "AUTH_ERROR";
  if (error?.status === 504 || /timed out|timeout/i.test(message))
    return "AI_TIMEOUT";
  if (error?.status === 503 || /unavailable|overloaded/i.test(message))
    return "PROVIDER_UNAVAILABLE";
  return "AI_REQUEST_FAILED";
}

function toFriendlyError(error) {
  const code = resolveErrorCode(error);
  const known = FRIENDLY_ERRORS[code] || FRIENDLY_ERRORS.AI_REQUEST_FAILED;
  const status =
    code === "AI_REQUEST_FAILED" && Number(error?.status)
      ? Number(error.status)
      : known.status;
  return {
    status,
    code,
    title: known.title,
    message: known.message,
    degraded: true,
  };
}

function sendAIError(res, error) {
  const info = toFriendlyError(error);
  console.error(`[AI Error] ${info.code}: ${error?.message || error}`);
  return res.status(info.status).json({ ...info, error: info.message });
}

function logQuery(query, meta = {}) {
  // Credentials are redacted at the last moment too, in case a guard upstream
  // is ever missed: the log line must never carry a usable email/password.
  console.info(
    "[Query]",
    JSON.stringify({ query: redactCredentials(query).slice(0, 120), ...meta }),
  );
}

// ======================================================
// WEBSOCKET (optional dependency)
// ======================================================

let WebSocket;
try {
  WebSocket = require("ws");
} catch (_e) {
  console.warn("[WebSocket] ws package is not available");
}

// ======================================================
// ROUTES
// ======================================================

const healthPayload = () => ({
  ok: true,
  provider: providerLabel,
  ollama: ollamaReady,
  ollamaHost,
  ollamaModel,
  ollamaLastError,
  postgres: Boolean(databaseUrl),
  dbReady,
  cacheTable: "query_cache",
  semanticCache: {
    enabled: SEMANTIC_CACHE_ENABLED,
    model: EMBED_MODEL,
    dim: EMBED_DIM,
    minSimilarity: SEMANTIC_MIN_SIMILARITY,
  },
  orderFastPath: ORDER_FAST_PATH,
  traceStream: STREAM_TRACE_ENABLED,
  websocket: Boolean(WebSocket && WebSocket.Server),
  cache: cacheManager.getStats(),
  latency: {
    keepAlive: OLLAMA_KEEP_ALIVE,
    numCtx: OLLAMA_NUM_CTX,
    maxTokens: AI_MAX_TOKENS,
    requestTimeoutMs: AI_REQUEST_TIMEOUT_MS,
    firstTokenTimeoutMs: FIRST_TOKEN_TIMEOUT_MS,
  },
});

app.get("/", (_req, res) => {
  res.json({
    message:
      "OpsMate Backend & WebSocket Server is running (Ollama + PostgreSQL cache)",
    endpoints: {
      health: "GET /health | GET /api/health",
      search: "GET /api/search?q=... | POST /api/search { query }",
      assist:
        "GET /api/assist?q=... | POST /api/assist { query, history }  (streams plain text)",
      classify: "POST /api/classify { query }",
      order: "GET /api/orders/:id",
      cacheStats: "GET /api/cache/stats",
      cacheFlush: "POST /api/cache/flush",
      testOrder: "GET /api/test-order",
      websocket: `ws://localhost:${PORT}`,
    },
  });
});

app.get("/health", (_req, res) => res.status(200).json(healthPayload()));
app.get("/api/health", (_req, res) => res.status(200).json(healthPayload()));

// ======================================================
// AUTH API (user interface backing)
// Reuses ../mcp/auth.js — the SAME bcrypt hashing, session
// tokens and role model the MCP servers use, so a token issued
// here authenticates MCP clients too and vice versa.
//
// - POST /api/auth/register { name, email, password } → always role 'user'
// - POST /api/auth/login    { email, password }        → { user, token }
// - GET  /api/auth/me       (Authorization: Bearer …)  → verified identity
// - POST /api/auth/logout   (Authorization: Bearer …)  → revokes session
// Passwords and tokens are never logged.
// ======================================================

const authApi = createAuth(pool);

function bearerTokenOf(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

app.post("/api/auth/register", async (req, res) => {
  try {
    const user = await authApi.registerUser({
      name: req.body?.name,
      email: req.body?.email,
      password: req.body?.password,
    });
    res.status(201).json({ ok: true, user });
  } catch (error) {
    if (error instanceof authApi.AuthError) {
      res.status(400).json({ ok: false, error: error.message });
    } else {
      res
        .status(500)
        .json({
          ok: false,
          error: "Registration failed due to a server error.",
        });
    }
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const user = await authApi.loginUser({
      email: req.body?.email,
      password: req.body?.password,
    });
    const { token, expiresAt } = await authApi.createSession(user.id);
    // Token goes ONLY in the JSON body (the browser keeps it in
    // sessionStorage); it is never logged.
    res.json({ ok: true, user, token, expiresAt });
  } catch (error) {
    if (error instanceof authApi.AuthError) {
      res.status(401).json({ ok: false, error: error.message });
    } else {
      res
        .status(500)
        .json({ ok: false, error: "Login failed due to a server error." });
    }
  }
});

app.get("/api/auth/me", async (req, res) => {
  // Read the body so Express's JSON parser (app.use(express.json())) can
  // populate req.body; without it, req.body is undefined and this route
  // would always die with "Invalid JSON body" even for a simple header-only
  // GET with a Bearer token.
  try {
    await req.json();
  } catch (_e) {
    /* body is optional for me */
  }

  const token = bearerTokenOf(req);
  const context = token ? await authApi.resolveSessionToken(token) : null;
  if (!context) {
    return res
      .status(401)
      .json({ ok: false, error: "Authentication required." });
  }
  res.json({
    ok: true,
    user: {
      id: context.userId,
      name: context.name,
      email: context.email,
      role: context.role,
    },
    order_access: context.role === "admin" ? "all orders" : "own orders only",
  });
});

app.post("/api/auth/logout", async (req, res) => {
  const token = bearerTokenOf(req);
  const context = token ? await authApi.resolveSessionToken(token) : null;
  if (context && token) {
    await authApi.expireSession(context, token);
  }
  res.json({ ok: true });
});

// ======================================================
// ADMIN PANEL APIs (admin-only, verified session required)
//   GET /api/admin/stats     → dashboard KPIs
//   GET /api/admin/users     → all users (no password hashes)
//   GET /api/admin/orders    → ALL orders incl. legacy/NULL owners
//   GET /api/admin/products  → full catalog incl. inactive
//   POST /api/admin/products → create product
//   PATCH /api/admin/products/:sku → update price/stock/active
// ======================================================

// Fails closed: context must be a verified session with role === 'admin'.
function requireAdminContext(context, res) {
  if (!context) {
    res.status(401).json({ ok: false, error: "Sign in required." });
    return false;
  }
  if (context.role !== "admin") {
    res
      .status(403)
      .json({ ok: false, error: "Administrator privileges required." });
    return false;
  }
  return true;
}

app.get("/api/admin/stats", async (req, res) => {
  const { context, tokenPresented } = await authContextFor(req);
  if (tokenPresented && !context)
    return res
      .status(401)
      .json({ ok: false, error: "Invalid or expired session." });
  if (!requireAdminContext(context, res)) return;

  try {
    const [users, orders, products, revenue, recent] = await Promise.all([
      pool.query(
        "SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS new_7d FROM users",
      ),
      pool.query(
        "SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE status = 'processing')::int AS processing, COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS new_7d FROM orders",
      ),
      pool.query(
        "SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE is_active)::int AS active, COALESCE(SUM(stock_quantity), 0)::int AS stock FROM products",
      ),
      pool.query(
        "SELECT COALESCE(SUM(total_amount), 0)::numeric AS total FROM orders WHERE status NOT IN ('cancelled','refunded')",
      ),
      pool.query(
        "SELECT order_id, customer_name, status, total_amount, created_at FROM orders ORDER BY created_at DESC, id DESC LIMIT 8",
      ),
    ]);
    res.json({
      ok: true,
      users: users.rows[0],
      orders: orders.rows[0],
      products: products.rows[0],
      revenue_total: revenue.rows[0].total,
      recent_orders: recent.rows,
    });
  } catch (error) {
    console.error("[Admin] stats failed:", error.message);
    res.status(503).json({ ok: false, error: "Database unavailable." });
  }
});

app.get("/api/admin/users", async (req, res) => {
  const { context, tokenPresented } = await authContextFor(req);
  if (tokenPresented && !context)
    return res
      .status(401)
      .json({ ok: false, error: "Invalid or expired session." });
  if (!requireAdminContext(context, res)) return;

  try {
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 100, 1),
      500,
    );
    const rows = await pool.query(
      "SELECT id, name, email, role, is_active, created_at FROM users ORDER BY created_at DESC LIMIT $1",
      [limit],
    );
    res.json({ ok: true, users: rows.rows });
  } catch (error) {
    console.error("[Admin] users failed:", error.message);
    res.status(503).json({ ok: false, error: "Database unavailable." });
  }
});

// PATCH a user: admin can activate/deactivate or change role.
app.patch("/api/admin/users/:id", async (req, res) => {
  const { context, tokenPresented } = await authContextFor(req);
  if (tokenPresented && !context)
    return res
      .status(401)
      .json({ ok: false, error: "Invalid or expired session." });
  if (!requireAdminContext(context, res)) return;

  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1)
    return res.status(400).json({ ok: false, error: "Invalid user id." });
  if (id === context.userId)
    return res
      .status(400)
      .json({
        ok: false,
        error: "You cannot modify your own admin account from here.",
      });

  const wantsRole = req.body?.role !== undefined;
  const wantsActive = req.body?.is_active !== undefined;
  if (!wantsRole && !wantsActive)
    return res.status(400).json({ ok: false, error: "Nothing to update." });
  if (wantsRole && req.body.role !== "user" && req.body.role !== "admin") {
    return res
      .status(400)
      .json({ ok: false, error: "Role must be 'user' or 'admin'." });
  }
  if (wantsActive && typeof req.body.is_active !== "boolean") {
    return res
      .status(400)
      .json({ ok: false, error: "is_active must be true or false." });
  }

  try {
    const clauses = [];
    const params = [];
    if (wantsRole) {
      params.push(req.body.role);
      clauses.push("role = " + "$" + params.length);
    }
    if (wantsActive) {
      params.push(req.body.is_active);
      clauses.push("is_active = " + "$" + params.length);
    }
    params.push(id);

    // Deactivating or demoting a user must end their sessions immediately —
    // resolveSessionToken() checks is_active on every call, but revoking rows
    // keeps the sessions table clean.
    if (req.body.is_active === false || req.body.role === "user") {
      await pool.query("DELETE FROM sessions WHERE user_id = $1", [id]);
    }

    const result = await pool.query(
      `UPDATE users SET ${clauses.join(", ")} WHERE id = $${params.length} RETURNING id, name, email, role, is_active`,
      params,
    );
    if (!result.rows[0])
      return res.status(404).json({ ok: false, error: "User not found." });
    res.json({ ok: true, user: result.rows[0] });
  } catch (error) {
    console.error("[Admin] user update failed:", error.message);
    res.status(503).json({ ok: false, error: "Database unavailable." });
  }
});

app.get("/api/admin/orders", async (req, res) => {
  const { context, tokenPresented } = await authContextFor(req);
  if (tokenPresented && !context)
    return res
      .status(401)
      .json({ ok: false, error: "Invalid or expired session." });
  if (!requireAdminContext(context, res)) return;

  try {
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 100, 1),
      500,
    );
    const status = req.query.status
      ? String(req.query.status).slice(0, 50)
      : null;
    const params = [];
    const statusClause = status
      ? (params.push(status), "WHERE status = $" + params.length)
      : "";
    const rows = await pool.query(
      `SELECT o.id, o.order_id, o.customer_name, o.status, o.total_amount, o.created_at,
              u.name AS owner_name, u.email AS owner_email
         FROM orders o
         LEFT JOIN users u ON u.id = o.user_id
         ${statusClause}
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT $${params.length + 1}`,
      [...params, limit],
    );
    res.json({ ok: true, orders: rows.rows });
  } catch (error) {
    console.error("[Admin] orders failed:", error.message);
    res.status(503).json({ ok: false, error: "Database unavailable." });
  }
});

app.get("/api/admin/products", async (req, res) => {
  const { context, tokenPresented } = await authContextFor(req);
  if (tokenPresented && !context)
    return res
      .status(401)
      .json({ ok: false, error: "Invalid or expired session." });
  if (!requireAdminContext(context, res)) return;

  try {
    const rows = await pool.query(
      "SELECT id, sku, name, description, price, stock_quantity, is_active, created_at FROM products ORDER BY id",
    );
    res.json({ ok: true, products: rows.rows });
  } catch (error) {
    console.error("[Admin] products failed:", error.message);
    res.status(503).json({ ok: false, error: "Database unavailable." });
  }
});

// POST create a new product
app.post("/api/admin/products", async (req, res) => {
  const { context, tokenPresented } = await authContextFor(req);
  if (tokenPresented && !context)
    return res
      .status(401)
      .json({ ok: false, error: "Invalid or expired session." });
  if (!requireAdminContext(context, res)) return;

  const name = String(req.body?.name ?? "").trim();
  const sku = String(req.body?.sku ?? "")
    .trim()
    .toUpperCase();
  const price = Number(req.body?.price);
  const stock = Number(req.body?.stock_quantity ?? 0);

  if (name.length < 1 || name.length > 150)
    return res
      .status(400)
      .json({ ok: false, error: "Product name must be 1-150 characters." });
  if (sku.length < 1 || sku.length > 50 || !/^[A-Z0-9-_]+$/.test(sku))
    return res
      .status(400)
      .json({
        ok: false,
        error: "SKU must be 1-50 characters (A-Z, 0-9, dash, underscore).",
      });
  if (!Number.isFinite(price) || price < 0)
    return res
      .status(400)
      .json({ ok: false, error: "Price must be a number >= 0." });
  if (!Number.isInteger(stock) || stock < 0)
    return res
      .status(400)
      .json({ ok: false, error: "Stock must be a non-negative integer." });

  try {
    const result = await pool.query(
      `INSERT INTO products (sku, name, description, price, stock_quantity)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, sku, name, price, stock_quantity, is_active`,
      [
        sku,
        name,
        String(req.body?.description ?? "").slice(0, 1000),
        price,
        stock,
      ],
    );
    res.status(201).json({ ok: true, product: result.rows[0] });
  } catch (error) {
    if (error.code === "23505")
      return res
        .status(400)
        .json({ ok: false, error: "A product with this SKU already exists." });
    console.error("[Admin] product create failed:", error.message);
    res.status(503).json({ ok: false, error: "Database unavailable." });
  }
});

// PATCH price/stock/active for one product by SKU
app.patch("/api/admin/products/:sku", async (req, res) => {
  const { context, tokenPresented } = await authContextFor(req);
  if (tokenPresented && !context)
    return res
      .status(401)
      .json({ ok: false, error: "Invalid or expired session." });
  if (!requireAdminContext(context, res)) return;

  const sku = String(req.params.sku ?? "")
    .trim()
    .toUpperCase();
  if (!sku) return res.status(400).json({ ok: false, error: "SKU required." });

  const wants = {};
  if (req.body?.price !== undefined) {
    const price = Number(req.body.price);
    if (!Number.isFinite(price) || price < 0)
      return res
        .status(400)
        .json({ ok: false, error: "Price must be a number >= 0." });
    wants.price = price;
  }
  if (req.body?.stock_quantity !== undefined) {
    const stock = Number(req.body.stock_quantity);
    if (!Number.isInteger(stock) || stock < 0)
      return res
        .status(400)
        .json({ ok: false, error: "Stock must be a non-negative integer." });
    wants.stock_quantity = stock;
  }
  if (req.body?.is_active !== undefined) {
    if (typeof req.body.is_active !== "boolean")
      return res
        .status(400)
        .json({ ok: false, error: "is_active must be true or false." });
    wants.is_active = req.body.is_active;
  }
  if (!Object.keys(wants).length)
    return res.status(400).json({ ok: false, error: "Nothing to update." });

  try {
    const clauses = [];
    const params = [];
    if (wants.price !== undefined) {
      params.push(wants.price);
      clauses.push("price = $" + params.length);
    }
    if (wants.stock_quantity !== undefined) {
      params.push(wants.stock_quantity);
      clauses.push("stock_quantity = $" + params.length);
    }
    if (wants.is_active !== undefined) {
      params.push(wants.is_active);
      clauses.push("is_active = $" + params.length);
    }
    params.push(sku);
    params.push(new Date());

    const result = await pool.query(
      `UPDATE products SET ${clauses.join(", ")}, updated_at = $${params.length} WHERE sku = $${params.length - 1}
       RETURNING id, sku, name, price, stock_quantity, is_active`,
      params,
    );
    if (!result.rows[0])
      return res.status(404).json({ ok: false, error: "Product not found." });
    res.json({ ok: true, product: result.rows[0] });
  } catch (error) {
    console.error("[Admin] product update failed:", error.message);
    res.status(503).json({ ok: false, error: "Database unavailable." });
  }
});

app.get("/api/cache/stats", (_req, res) => res.json(cacheManager.getStats()));

// ======================================================
// POLICY RESOURCE ENDPOINT
// Exposes the company policy document for AI grounding and frontend display
// GET /api/policy - returns the full policy.md content
app.get("/api/policy", (_req, res) => {
  const policyContent = loadPolicy();
  res.set('Content-Type', 'text/markdown');
  res.send(policyContent);
});

app.post("/api/cache/flush", async (req, res) => {
  // Destructive cache management: only an authenticated session may flush.
  const { context, tokenPresented } = await authContextFor(req);
  if (tokenPresented && !context)
    return res
      .status(401)
      .json({ ok: false, error: "Invalid or expired session." });
  if (!context)
    return res.status(401).json({ ok: false, error: "Sign in required." });
  const result = await cacheManager.flush({
    memory: req.body?.memory !== false,
    database: req.body?.database !== false,
  });
  res.json({ ok: true, ...result, stats: cacheManager.getStats() });
});

// Embeds any cached rows that predate the semantic tier (embedding IS NULL).
app.post("/api/cache/backfill-embeddings", async (req, res) => {
  // Embedding backfill mutates cached rows: only an authenticated session may run it.
  const { context, tokenPresented } = await authContextFor(req);
  if (tokenPresented && !context)
    return res
      .status(401)
      .json({ ok: false, error: "Invalid or expired session." });
  if (!context)
    return res.status(401).json({ ok: false, error: "Sign in required." });
  const result = await cacheManager.backfillEmbeddings({
    limit: Number(req.body?.limit) || 500,
  });
  res.json({ ok: true, ...result, stats: cacheManager.getStats() });
});

// ---------- SEARCH (JSON) ----------

async function handleSearch(query, res, history, context = null) {
  const trimmed = String(query ?? "").trim();

  if (!trimmed) {
    return res
      .status(400)
      .json({ error: "Missing query. Use ?q=... or JSON { query }" });
  }
  if (trimmed.length > 2000) {
    return res
      .status(400)
      .json({ error: "Query too long (max 2000 characters)" });
  }

  const t0 = nowMs();

  try {
    const out = await answerQuery(trimmed, { history, context });
    const latencyMs = Number((nowMs() - t0).toFixed(1));
    const layer = out.cache.layer;

    res.set("X-Cache", layer);
    res.set("X-Provider", providerLabel);
    res.set("Server-Timing", `total;dur=${latencyMs}`);
    if (out.usedTool) res.set("X-Tool", "order-lookup");
    logQuery(trimmed, { layer, latencyMs, model: out.model });

    return res.status(200).json({
      query: trimmed,
      answer: out.answer,
      model: out.model,
      usage: out.usage,
      source: out.source,
      usedTool: Boolean(out.usedTool),
      rounds: out.rounds ?? null,
      cached: out.cache.hit,
      cache: out.cache,
      exactCacheHit: layer === "L1_MEMORY" || layer === "L2_POSTGRES",
      similarity: out.cache.similarity ?? null,
      latencyMs,
      degraded: false,
    });
  } catch (error) {
    return sendAIError(res, error);
  }
}

app.get("/api/search", async (req, res) => {
  const { context, tokenPresented } = await authContextFor(req);
  if (tokenPresented && !context)
    return res
      .status(401)
      .json({
        ok: false,
        error: "Invalid or expired session. Please sign in again.",
      });
  return handleSearch(req.query.q, res, null, context);
});
app.post("/api/search", async (req, res) => {
  const { context, tokenPresented } = await authContextFor(req);
  if (tokenPresented && !context)
    return res
      .status(401)
      .json({
        ok: false,
        error: "Invalid or expired session. Please sign in again.",
      });
  return handleSearch(
    req.body?.query ?? req.body?.q,
    res,
    req.body?.history,
    context,
  );
});

// ---------- ASSIST (streamed plain text, same contract as before) ----------

const STREAM_ERROR_PREFIX = "__OPSMATE_STREAM_ERROR__:";
// Carries embedding/semantic cache status to the client for a request that
// actually streamed tokens (layer MISS). Headers are locked by the time that
// status is known (they were flushed with the first delta, before Ollama's
// answer — and therefore the cache outcome — existed), so it rides along as a
// trailing marker in the body instead, exactly like STREAM_ERROR_PREFIX above.
// The frontend strips it out of the displayed answer and parses the JSON.
const STREAM_META_PREFIX = "__OPSMATE_STREAM_META__:";
const STREAM_TRACE_PREFIX = "__OPSMATE_TRACE__:";
// Pipeline trace events ride along on the same stream (prefix lives in
// backend/trace.js). Set TRACE_STREAM=false to keep the trace server-side only.
const STREAM_TRACE_ENABLED =
  String(process.env.TRACE_STREAM || "true").toLowerCase() !== "false";

// Which provider the final answer really came from (used for the X-Provider
// header AND for the trailing meta marker, so both agree).
function providerForResult(out, layer) {
  if (out.source === "postgres") return "postgres";
  if (layer === "MISS" || layer === "BYPASS_ORDER") return providerLabel;
  if (layer === "GREETING" || layer === "OUT_OF_SCOPE") return "scope-gate";
  return "cache";
}

async function handleAssist(query, body, res, context = null) {
  const trimmed = String(query ?? "").trim();

  if (!trimmed) {
    return res.status(400).json({ error: "Please type a question first." });
  }

  const history = Array.isArray(body?.history) ? body.history : [];
  const t0 = nowMs();
  let headersFlushed = false;
  let answerStreamed = false;
  let stopped = false;

  // Stop button: the browser closes the connection, so cancel the model call too.
  // Without this the client stops rendering but Ollama keeps generating.
  const controller = new AbortController();
  const onClientClose = () => {
    if (res.writableEnded) return; // our own response finished normally
    stopped = true;
    controller.abort();
    console.log(
      `[Assist] client disconnected after ${Number(nowMs() - t0).toFixed(0)}ms — cancelling generation`,
    );
  };
  res.on("close", onClientClose);

  // Once ANY byte is written (a trace line or the first answer token) the
  // header block is gone, so every setHeader goes through this guard.
  const flushStreamHeaders = (extra = {}) => {
    if (headersFlushed) return;
    headersFlushed = true;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    for (const [key, value] of Object.entries(extra)) res.setHeader(key, value);
    res.flushHeaders?.();
  };

  const write = (text) => {
    if (stopped || res.writableEnded || res.destroyed) return false;
    flushStreamHeaders();
    try {
      res.write(text);
      return true;
    } catch (_e) {
      stopped = true;
      controller.abort();
      return false;
    }
  };

  // ONE tracer per request: every pipeline step prints one staged console line
  // and is streamed to the browser as a trace event, so the UI can show the
  // same steps live (query understood -> tool chosen -> tool result -> answer)
  // while the model is still working.
  const trace = createTracer({
    onEvent: STREAM_TRACE_ENABLED
      ? (event) =>
          write(`${STREAM_TRACE_PREFIX}${JSON.stringify(event)}\n`)
      : undefined,
  });

  try {
    const out = await answerQuery(trimmed, {
      history,
      context,
      signal: controller.signal,
      onTrace: trace.stage,
      onDelta: (chunk) => {
        if (stopped) return; // stop writing immediately
        answerStreamed = true;
        write(chunk);
      },
    });

    if (stopped) {
      logQuery(trimmed, {
        layer: out.cache.layer,
        latencyMs: Number((nowMs() - t0).toFixed(1)),
        stopped: true,
      });
      try {
        res.end();
      } catch (_e) {
        /* socket already gone */
      }
      return;
    }

    const latencyMs = Number((nowMs() - t0).toFixed(1));
    const layer = out.cache.layer;
    const model = out.model || ollamaModel;
    const provider = providerForResult(out, layer);
    const tool = out.tool || null;
    const answerChars = String(out.answer || "").length;

    // Final step, emitted BEFORE the trailing meta marker below: the frontend
    // treats that marker as terminal, so nothing may follow it.
    trace.stage({
      stage: "done",
      title: `Answered from ${layer}`,
      detail: `${answerChars} char(s)${tool ? ` · tool ${tool}` : ""}`,
      ms: latencyMs,
    });

    if (!headersFlushed) {
      // Nothing was written at all (streaming trace disabled): the whole header
      // block is still open, so every value can still go out as a real header.
      flushStreamHeaders({
        "X-Provider": provider,
        "X-Model": model,
        "X-Cache": layer,
        "Server-Timing": `total;dur=${latencyMs}`,
        "X-Embedding-Cache": out.cache.embeddingStatus || "SKIPPED",
        "X-Semantic-Cache": out.cache.semanticStatus || "SKIPPED",
        ...(out.cache.similarity != null
          ? { "X-Similarity": String(out.cache.similarity) }
          : {}),
        ...(tool ? { "X-Tool": tool } : {}),
      });
      if (out.answer) write(out.answer);
    } else {
      // Trace lines (and/or the first answer token) already flushed the header
      // block before the cache outcome existed, so the authoritative result
      // rides along as a trailing marker instead — exactly like the error
      // marker. The frontend strips it from the answer and applies it.
      //
      // A CACHE HIT is never delivered through onDelta (the cache manager returns
      // the stored row directly), so its answer still has to be written here —
      // otherwise a hit streamed the steps and the badge but no answer at all.
      if (!answerStreamed && out.answer) write(out.answer);
      write(
        `\n${STREAM_META_PREFIX}${JSON.stringify({
          layer,
          provider,
          model,
          tool,
          rounds: out.rounds ?? null,
          serverMs: latencyMs,
          embeddingStatus: out.cache.embeddingStatus || null,
          semanticStatus: out.cache.semanticStatus || null,
          similarity: out.cache.similarity ?? null,
        })}`,
      );
    }

    logQuery(trimmed, {
      layer,
      latencyMs,
      model,
      streamed: true,
      cached: out.cache.hit,
    });
    return res.end();
  } catch (error) {
    if (stopped || error?.code === "CLIENT_ABORTED") {
      console.log(
        `[Assist] generation stopped (${error?.code || "client disconnect"})`,
      );
      try {
        res.end();
      } catch (_e) {
        /* socket already gone */
      }
      return;
    }

    const info = toFriendlyError(error);
    console.error(`[Assist] ${info.code}: ${error?.message || error}`);

    // Last trace step = where the pipeline broke (written to the client before
    // the error marker below, so the UI shows both).
    trace.stage({
      stage: "error",
      status: "error",
      title: info.code,
      detail: info.message,
    });

    if (res.headersSent || headersFlushed) {
      write(`${STREAM_ERROR_PREFIX}${info.message}`);
      return res.end();
    }
    // Pre-stream failure: keep the 200 streaming contract, but send the
    // friendly message behind the stream-error marker. A plain JSON body with
    // status 200 would be piped through the proxy and rendered as the answer.
    flushStreamHeaders({ "X-Cache": "ERROR" });
    write(`${STREAM_ERROR_PREFIX}${info.message}`);
    return res.end();
  } finally {
    res.removeListener("close", onClientClose);
  }
}

app.get("/api/assist", async (req, res) => {
  if (req.query.stats !== undefined) return res.json(cacheManager.getStats());
  const { context, tokenPresented } = await authContextFor(req);
  if (tokenPresented && !context)
    return res
      .status(401)
      .json({
        ok: false,
        error: "Invalid or expired session. Please sign in again.",
      });
  return handleAssist(req.query.q, {}, res, context);
});
app.post("/api/assist", async (req, res) => {
  const { context, tokenPresented } = await authContextFor(req);
  if (tokenPresented && !context)
    return res
      .status(401)
      .json({
        ok: false,
        error: "Invalid or expired session. Please sign in again.",
      });
  return handleAssist(req.body?.query ?? req.body?.q, req.body, res, context);
});

// ---------- ORDER (direct lookup, redacted) ----------

app.get("/api/orders/:id", async (req, res) => {
  // Same ownership rule as the chat pipeline: a Bearer token is REQUIRED for
  // order access; a verified user only sees their own orders, an admin sees all.
  const { context, tokenPresented } = await authContextFor(req);
  if (tokenPresented && !context)
    return res
      .status(401)
      .json({
        ok: false,
        error: "Invalid or expired session. Please sign in again.",
      });
  if (!context)
    return res
      .status(401)
      .json({ ok: false, error: "Sign in to view order details." });
  const ownerUserId = orderOwnerUserId(context, null);

  try {
    const order = await lookupOrder(req.params.id, ownerUserId);
    if (!order)
      return res
        .status(404)
        .json({
          error: "Order not found",
          orderId: formatOrderId(req.params.id),
        });
    return res.status(200).json(safeOrder(order));
  } catch (error) {
    console.error("[PostgreSQL] Order lookup failed:", error.message);
    const info = toFriendlyError(
      Object.assign(error, { code: "DB_UNAVAILABLE" }),
    );
    return res.status(info.status).json({ ...info, error: info.message });
  }
});

app.get("/api/test-order", async (req, res) => {
  // This is a debug helper, not a public endpoint: it exposes a real order row.
  // Require a verified session so anonymous callers cannot read any order data.
  const { context, tokenPresented } = await authContextFor(req);
  if (tokenPresented && !context)
    return res
      .status(401)
      .json({ ok: false, error: "Invalid or expired session." });
  if (!context)
    return res.status(401).json({ ok: false, error: "Sign in required." });
  try {
    const result = await pool.query("SELECT * FROM orders LIMIT 1");
    return res
      .status(200)
      .json(result.rows[0] ? safeOrder(result.rows[0]) : null);
  } catch (error) {
    console.error("[PostgreSQL] Test order failed:", error.message);
    const info = toFriendlyError(
      Object.assign(error, { code: "DB_UNAVAILABLE" }),
    );
    return res.status(info.status).json({ ...info, error: info.message });
  }
});

// ---------- CLASSIFY (Ollama JSON output, cached in memory) ----------

const ticketSchema = z.object({
  category: z.enum(["order", "refund", "technical", "account", "general"]),
  priority: z.enum(["low", "medium", "high"]),
  customer: z.object({
    issue: z.string(),
    sentiment: z.enum(["positive", "neutral", "negative"]),
  }),
});

const classifyCache = new TTLCache(300);

function fallbackClassification(query) {
  const q = String(query).toLowerCase();
  const category = /refund|return|money back/.test(q)
    ? "refund"
    : /order|shipping|deliver|track|cancel/.test(q)
      ? "order"
      : /password|login|account|email|address/.test(q)
        ? "account"
        : /error|bug|fail|crash|api|slow/.test(q)
          ? "technical"
          : "general";
  const priority = /urgent|asap|angry|charged|fraud|blocked/.test(q)
    ? "high"
    : "medium";
  const sentiment = /angry|unacceptable|terrible|worst|frustrat/.test(q)
    ? "negative"
    : "neutral";
  return {
    category,
    priority,
    customer: { issue: String(query).slice(0, 200), sentiment },
  };
}

async function classifyTicket(query) {
  const key = normalizeQuery(query);
  const cached = classifyCache.get(key);
  if (cached) return { ...cached, cached: true };

  // Bounded like every other model call: without the watchdog a wedged Ollama
  // would hang this request forever instead of failing with a friendly error.
  const result = await withTimeout(
    ollama.chat({
      model: ollamaModel,
      messages: [
        {
          role: "system",
          content: "You classify support tickets. Reply with JSON only.",
        },
        {
          role: "user",
          content:
            "Classify this OpsMate customer request into JSON with keys category " +
            '("order"|"refund"|"technical"|"account"|"general"), priority ("low"|"medium"|"high"), ' +
            'and customer { issue, sentiment ("positive"|"neutral"|"negative") }. ' +
            `Request: ${query}`,
        },
      ],
      stream: false,
      format: "json",
      keep_alive: OLLAMA_KEEP_ALIVE,
      options: { temperature: 0, num_predict: 200, num_ctx: OLLAMA_NUM_CTX },
    }),
    AI_REQUEST_TIMEOUT_MS,
    "ollama.chat (classify)",
  );

  let parsed;
  try {
    parsed = ticketSchema.parse(JSON.parse(result.message?.content || "{}"));
  } catch (_e) {
    parsed = fallbackClassification(query);
  }

  const out = {
    object: parsed,
    usage: {
      promptTokens: result.prompt_eval_count ?? 0,
      completionTokens: result.eval_count ?? 0,
      totalTokens: (result.prompt_eval_count ?? 0) + (result.eval_count ?? 0),
    },
    model: ollamaModel,
  };
  classifyCache.set(key, out, 10 * 60 * 1000);
  return { ...out, cached: false };
}

app.post("/api/classify", async (req, res) => {
  try {
    const query = String(req.body?.query ?? "").trim();
    if (!query) return res.status(400).json({ error: "Missing query" });

    const t0 = nowMs();
    const result = await classifyTicket(query);

    return res.status(200).json({
      query,
      classification: result.object,
      model: result.model,
      usage: result.usage,
      cached: result.cached,
      latencyMs: Number((nowMs() - t0).toFixed(1)),
    });
  } catch (error) {
    return sendAIError(res, classifyOllamaError(error));
  }
});

// ======================================================
// HTTP SERVER + WEBSOCKET
// ======================================================

const server = http.createServer(app);

if (WebSocket && WebSocket.Server) {
  const wss = new WebSocket.Server({ server });

  wss.on("connection", (ws) => {
    console.log("WebSocket client connected to OpsMate WebSocket Server");

    const send = (obj) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    };

    send({
      type: "status",
      status: "connected",
      message: "WebSocket Connected to OpsMate Backend",
    });

    ws.on("message", async (message) => {
      let payload;
      try {
        payload = JSON.parse(message.toString());
      } catch (_e) {
        return send({
          type: "error",
          code: "INVALID_MESSAGE",
          error: "Invalid WebSocket message",
        });
      }

      const query = String(payload.query || payload.message || "").trim();
      if (!query) return send({ type: "error", error: "Missing query" });

      // Optional per-connection identity: a client MAY send its session token
      // with the query payload. Present-and-invalid is REJECTED (fail closed)
      // so a stale session can never be widened to the service account.
      let wsContext = null;
      if (typeof payload.token === "string" && payload.token.trim()) {
        wsContext = await authApi.resolveSessionToken(payload.token.trim());
        if (!wsContext) {
          return send({
            type: "error",
            code: "INVALID_SESSION",
            error: "Invalid or expired session. Please sign in again.",
          });
        }
      }

      send({
        type: "status",
        status: "processing",
        message: "Processing query via Ollama...",
      });

      const t0 = nowMs();
      try {
        // Same pipeline trace as HTTP, streamed to the socket as trace events so
        // a WebSocket client can render the steps live too.
        const trace = createTracer({
          onEvent: (event) => send({ type: "trace", event }),
        });
        const out = await answerQuery(query, {
          onTrace: trace.stage,
          context: wsContext,
        });
        send({
          type: "response",
          query,
          answer: out.answer,
          model: out.model,
          usage: out.usage,
          cached: out.cache.hit,
          cache: out.cache,
          latencyMs: Number((nowMs() - t0).toFixed(1)),
        });
      } catch (error) {
        const info = toFriendlyError(error);
        console.error(
          `[WebSocket] query failed [${info.code}]:`,
          error?.message || error,
        );
        send({ type: "error", ...info, error: info.message });
      }
    });

    ws.on("close", () => console.log("WebSocket client disconnected"));
    ws.on("error", (error) =>
      console.error("[WebSocket] Connection error:", error.message),
    );
  });
}

// ======================================================
// ERROR HANDLING + SHUTDOWN
// ======================================================

app.use((error, _req, res, _next) => {
  console.error("[Express] Unhandled error:", error);
  if (res.headersSent) return;

  if (error.type === "entity.parse.failed") {
    const body = {
      error: "Invalid JSON body. Check the request payload and try again.",
      message: "Invalid JSON body. Check the request payload and try again.",
      title: "Bad request",
      code: "BAD_REQUEST",
      degraded: true,
    };
    return res.status(400).json(body);
  }

  const info = toFriendlyError(error);
  return res.status(info.status).json({ ...info, error: info.message });
});

process.on("unhandledRejection", (reason) =>
  console.error("[Process] Unhandled Promise Rejection:", reason),
);
process.on("uncaughtException", (error) =>
  console.error("[Process] Uncaught Exception:", error),
);

function shutdown(signal) {
  console.log(`${signal} received. Starting graceful shutdown...`);
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();

  server.close(async () => {
    try {
      await pool.end();
      console.log("PostgreSQL pool closed.");
    } catch (error) {
      console.error("PostgreSQL shutdown error:", error.message);
    }
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ======================================================
// START
// ======================================================

const HOST = process.env.HOST || "127.0.0.1";
server.listen(PORT, HOST, async () => {
  const line = "==================================================";
  console.log(line);
  console.log("OpsMate Backend Server Started  (Ollama + PostgreSQL cache)");
  console.log(line);
  console.log(`HTTP        : http://localhost:${PORT}`);
  console.log(`WebSocket   : ws://localhost:${PORT}`);
  console.log(`AI provider : ollama (${ollamaHost})`);
  console.log(
    `Model       : ${ollamaModel}  keep_alive=${OLLAMA_KEEP_ALIVE} num_ctx=${OLLAMA_NUM_CTX}`,
  );
  console.log(
    `Timeout     : ${AI_REQUEST_TIMEOUT_MS}ms | first token ${FIRST_TOKEN_TIMEOUT_MS}ms | max tokens ${AI_MAX_TOKENS}`,
  );
  console.log(`Order fast  : ${ORDER_FAST_PATH}`);
  console.log(
    `Cache       : ${CACHE_ENABLED ? `L1 memory ${CACHE_L1_TTL_SEC}s -> L2 PostgreSQL query_cache (${CACHE_TTL_SEC}s / live${CACHE_LIVE_TTL_SEC}s)` : "disabled"}`,
  );
  console.log(
    `Semantic    : ${SEMANTIC_CACHE_ENABLED ? `${EMBED_MODEL} (${EMBED_DIM}d, min similarity${SEMANTIC_MIN_SIMILARITY})` : "disabled"}`,
  );
  console.log(`PostgreSQL  : ${databaseUrl ? "configured" : "missing"}`);
  console.log(
    `MCP tools   : get_order, list_orders, check_stock, search_products, update_stock (shared ../mcp/tools.js)`,
  );
  console.log(line);

  if (aiProvider !== "ollama") {
    console.warn(
      `[Config] AI_PROVIDER="${aiProvider}" is ignored: Ollama is the only configured provider now.`,
    );
  }

  // Schema + warm connections so the FIRST user request doesn't pay connect/load cost.
  // All table/extension/index creation now lives in ./schema.js (ensureSchema),
  // including the pgvector embedding-cache columns — see FIX #5 above.
  try {
    if (databaseUrl) {
      await ensureSchema(pool, {
        embeddingModel: EMBED_MODEL,
        embeddingDim: EMBED_DIM,
        logger: console,
      });
      dbReady = true;
      console.log(
        `[Warmup] PostgreSQL ready (query_cache table ensured, prompt version ${PROMPT_VERSION})`,
      );
      // Pre-warm several POOL sockets in parallel (the per-45s heartbeat only
      // guarantees one): a cache write under a slow LLM miss otherwise opens a
      // cold connection (~12s measured) and trips the cache I/O ceiling. These
      // clients stay idle in the pool once the SELECT returns.
      const warmSockets = await Promise.allSettled([
        pool.query("SELECT 1"),
        pool.query("SELECT 1"),
        pool.query("SELECT 1"),
        pool.query("SELECT 1"),
      ]);
      console.log(
        `[Warmup] PostgreSQL pool pre-warmed: ${warmSockets.filter((r) => r.status === "fulfilled").length} socket(s)`,
      );
      const cached = await pool.query(
        "SELECT COUNT(*)::int AS n FROM query_cache",
      );
      console.log(`[Warmup] query_cache rows: ${cached.rows[0]?.n ?? 0}`);
    } else {
      console.warn(
        "[DB] DATABASE_URL is not set — the PostgreSQL answer cache is disabled.",
      );
    }
  } catch (e) {
    dbReady = false;
    console.warn(
      "[Warmup] PostgreSQL not ready — running without the persistent cache:",
      e.message,
    );
  }

  warmUpOllama();

  // Semantic cache: embed any legacy rows stored without a vector (best-effort,
  // runs in the background so boot is never delayed).
  if (SEMANTIC_CACHE_ENABLED) {
    setTimeout(async () => {
      const r = await cacheManager.backfillEmbeddings({ limit: 500 });
      if (!r.skipped && r.scanned > 0) {
        console.log(
          `[Embed] backfill: ${r.embedded}/${r.scanned} legacy row(s) embedded`,
        );
      }
    }, 1500).unref?.();
  }

  // Cheap heartbeat: keeps at least one pooled socket warm so the cache never pays
  // the cold-connect cost, and refreshes the dbReady flag for /health.
  const heartbeat = setInterval(
    () => {
      pool
        .query("SELECT 1")
        .then(() => {
          dbReady = true;
        })
        .catch(() => {
          dbReady = false;
        });
    },
    Number(process.env.PG_HEARTBEAT_MS || 45000),
  );
  heartbeat.unref();
});

module.exports = {
  app,
  server,
  cacheManager,
  normalizeQuery,
  PROMPT_VERSION,
  extractOrderId,
  classifyQueryScope,
  resolveAnswer,
  mcpTools,
  callMcpTool,
  MCP_TOOLS_FOR_OLLAMA,
};
