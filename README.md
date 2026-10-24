# OpsMate — Operations Assistant

**Packaging as a client deliverable** — this repository is packaged so a client can run, customize, and extend OpsMate as an operations/e-commerce support assistant.

---

## 📦 Package Overview

OpsMate is a full-stack operations assistant that connects to a local Ollama LLM and PostgreSQL database. It helps e-commerce support teams answer order-status questions, check product stock, and manage orders through natural language.

**Architecture:**
- **Frontend** (`frontend/`) — Next.js UI on port 3001
- **Backend** (`backend/`) — Express API on port 5000, Ollama + PostgreSQL integration
- **MCP Server** (`mcp/`) — Model Context Protocol server for tool-based AI interactions
- **Reverse Proxy** (Caddy) — single-origin entrypoint on port 3001

**Requirements:**
- [Ollama](https://ollama.ai) daemon running locally (model: `llama3.2:3b` default)
- [PostgreSQL](https://www.postgresql.org) (via Docker recommended)
- Node.js 20+ (for local development)

---

## 🛠️ Installation Guide

### Prerequisites

1. **Install Ollama**
   - Download and install from [ollama.ai](https://ollama.ai)
   - Start the daemon: `ollama serve`
   - Pull the default model: `ollama pull llama3.2:3b`

2. **Install Docker Desktop** (for PostgreSQL)
   - Required if not already running PostgreSQL locally

3. **Install Node.js dependencies**

   ```bash
   # Backend
   cd backend && npm install

   # Frontend
   cd frontend && npm install

   # MCP server
   cd mcp && npm install
   ```

### Database Setup

1. **Start PostgreSQL via Docker** (recommended):
   ```bash
   docker compose up -d postgres
   ```

2. **Or run PostgreSQL directly**:
   - Ensure a database named `opsmate` exists
   - User: `opsmate`, Password: `opsmate_password`

3. **Run schema migrations**:
   The backend auto-runs schema creation on startup via `schema.js`. The following tables/extensions are created:
   - `pgvector` extension for semantic search
   - `query_cache` table: `query_norm` (PK), `query`, `answer`, `model`, `prompt_version`, `hits`, `latency_ms`, `created_at`, `expires_at`
   - `queries` audit table: `query`, `answer`, `model`, `cached`, `latency_ms`
   - `orders` table: order tracking with items
   - `products` table: product catalog with stock

   _Manual migration (if needed)_: run `sql/` scripts or use the backend's `ensureSchema()` function at startup.

### Environment Configuration

Copy the example env files and adjust as needed (see `.env.example` files below).

```bash
# From project root
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
cp mcp/.env.example mcp/.env
```

### Start the System

**Docker (single-port, recommended):**
```bash
docker compose up --build -d
```
Everything serves from `http://localhost:3001`.

**Local development:**
```bash
# Start backend (port 5000)
cd backend && npm run dev

# Start frontend (port 3001)
cd frontend && npm run dev
```

**Verify it works:**
```bash
curl http://localhost:5000/health
# Expected: provider=ollama, dbReady=true

curl -X POST http://localhost:5000/api/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"where is order ORD-1001"}'
# First: X-Cache: MISS (triggers Ollama)
# Second: X-Cache: L1_MEMORY (cached in-process)
```

---

## ⚙️ Configuration Guide

### Environment Variables

#### Backend (`backend/.env`)

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection string (`@postgres:` rewritten to `@localhost:` for local dev) |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama daemon address |
| `OLLAMA_MODEL` | `llama3.2:3b` | Model name |
| `OLLAMA_KEEP_ALIVE` | `30m` | Keeps model resident in RAM |
| `OLLAMA_NUM_CTX` | `4096` | Context window (smaller = faster) |
| `OLLAMA_TIMEOUT_MS` | `600000` | Hard ceiling per model call |
| `AI_MAX_TOKENS` | `80` | Output cap — biggest latency lever on CPU-only Ollama |
| `CACHE_ENABLED` | `true` | Master switch for both cache tiers |
| `CACHE_TTL_SEC` | `86400` | Generic answers: 24h |
| `CACHE_LIVE_TTL_SEC` | `60` | Queries with digits/email: 60s |
| `SEMANTIC_CACHE_ENABLED` | `true` | Enable pgvector semantic cache |
| `ORDER_FAST_PATH` | `true` | Answer status questions from DB without LLM |
| `TRACE_STREAM` | `true` | Stream pipeline trace events to UI |

#### Frontend (`frontend/.env.local`)

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_WS_URL` | `ws://localhost:3001/ws` | WebSocket connection |
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001` | API backend URL |
| `BACKEND_URL` | `http://backend:5000` | Internal: backend URL in Docker |

#### MCP Server (`mcp/.env`)

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection string (required) |
| `MCP_AUTH_TOKEN` | — | Optional: session token for stdio clients |

> **Important:** Never commit real secrets. The `.env.example` files below show the variable names and defaults — copy them to `.env` and fill in your actual values.

#### `.env.example` Files

**backend/.env.example:**
```env
# Ollama (the ONLY model provider)
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.2:3b
OLLAMA_KEEP_ALIVE=30m
OLLAMA_NUM_CTX=4096
OLLAMA_TIMEOUT_MS=600000
OLLAMA_FIRST_TOKEN_TIMEOUT_MS=180000
AI_MAX_TOKENS=80
AI_MAX_TOOL_ROUNDS=4

# Database
DATABASE_URL=postgresql://opsmate:opsmate_password@localhost:5432/opsmate

# Cache
CACHE_ENABLED=true
CACHE_TTL_SEC=86400
CACHE_LIVE_TTL_SEC=60
CACHE_DB_TIMEOUT_MS=15000

# Behavior
ORDER_FAST_PATH=true
TRACE_STREAM=true
LOG_VERBOSE=false

# Embedding (semantic cache)
OLLAMA_EMBED_MODEL=nomic-embed-text
EMBEDDING_DIM=768
```

**frontend/.env.example** (rename to `.env.local`):
```env
# Next.js public vars must start with NEXT_PUBLIC_
NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws
NEXT_PUBLIC_API_URL=http://localhost:3001
```

**mcp/.env.example**:
```env
# PostgreSQL connection (required)
DATABASE_URL=postgresql://opsmate:opsmate_password@localhost:5432/opsmate

# Optional: stdio auth token (for Claude Desktop / MCP clients)
MCP_AUTH_TOKEN=your-opsservice-token-here
```

---

## 🗃️ Database Schema

The backend auto-creates all schema on first startup via `schema.js`. Key tables:

### `query_cache` (answer cache)
- `query_norm` — PK, normalized query string
- `query` — original user query
- `answer` — cached AI answer
- `model` — model name that generated the answer
- `prompt_version` — sha8 of the system prompt (changes invalidate cache)
- `hits` — hit count (legacy; per-tier counts live in memory)
- `created_at`, `expires_at` — TTL management
- Index on `query_norm` for exact match
- pgvector column for embedding-based semantic search

### `queries` (audit log)
- `query` — the user's question
- `answer` — the AI's answer
- `model` — model name
- `cached` — whether served from cache
- `latency_ms` — response latency

### `orders`
- `order_id` — e.g. `ORD-1001` (PK)
- `user_id` — owner (NULL = legacy/admin-visible)
- `customer_name`, `status`, `fulfillment_status`, `payment_status`
- `total_amount`, `currency`, `carrier`, `tracking_number`
- `created_at`, `updated_at`
- `items` — JSON line items

### `products`
- `id`, `sku`, `name`, `description`, `price`
- `stock_quantity`, `is_active`
- `updated_at`

### `users`
- `id`, `name`, `email`, `role` (user/admin)
- `password_hash`, `is_active`
- Session-based authentication

**pgvector extension** is required for semantic cache similarity search. The backend uses `nomic-embed-text` (768-dim vectors) by default.

---

## 🔐 Authentication Setup

### Transport Options

OpsMate supports two transport modes:

#### 1. STDIO (stdio — Model Context Protocol)

Used by the standalone MCP server (`mcp/index.js`) and clients like Claude Desktop.

- **Identity**: Session tokens are managed in-process. The first `login` call establishes an in-process session token that subsequent tool calls verify against.
- **Configuration**: Set `MCP_AUTH_TOKEN` in `mcp/.env`, or have the client pass it as an environment variable.
- **Per-request auth**: Each tool call carries an auth context verified against the database. Token revocation takes effect without restart.
- **Limitation**: In-process session state is shared per MCP process only — not suitable for multi-user web scenarios.

#### 2. Streamable HTTP (recommended for web)

Used by the Next.js frontend (`frontend/app/api/assist/route.ts` and `frontend/app/api/search/route.ts`).

- **Identity**: Bearer tokens sent via `Authorization: Bearer <token>` header.
- **Login flow**: User registers/login via `/api/auth/register` and `/api/auth/login`, receives a JWT-like session token.
- **Per-request verification**: Every protected route calls `getUser` to verify the token against the database. Admins vs users have different data access.
- **Recommended**: Use the frontend's auth flow — tokens are stored in `sessionStorage`/`localStorage` and sent automatically on API calls.

### Authentication Flow (HTTP / Web)

1. **Register**: `POST /api/auth/register` — creates a user account (role: `user`)
2. **Login**: `POST /api/auth/login` — returns a session token
3. **Verify identity**: `GET /api/auth/me` — returns the verified user context
4. **Logout**: `POST /api/auth/logout` — revokes the session token
5. **Admin actions**: Admins can access `/api/admin/*` endpoints with a verified admin token

### Authentication Flow (STDIO / MCP)

1. **Start MCP client** with `MCP_AUTH_TOKEN` env var or explicit token passage
2. **Login**: Call `login` tool with email/password — establishes in-process session
3. **Use tools**: All subsequent tool calls are automatically authenticated
4. **Logout**: Call `logout` tool to revoke the session
5. **Who am I**: Call `whoami` tool to see current auth context

---

## 📁 Project Structure

```
opsmate/
├── README.md                    # This file — client deliverable packaging
├── docker-compose.yml           # Docker orchestration (Caddy + frontend + backend + postgres)
├── Caddyfile                    # Reverse proxy config (port 3001)
├── .env                         # Root .env (— not used; backends load their own)
├── .gitignore                   # Git ignore rules
│
├── backend/                     # Express API + Ollama + PostgreSQL
│   ├── server.js                # Main Express app & route handlers
│   ├── schema.js                # Auto-run DB schema creation (pgvector, tables, indexes)
│   ├── .env.example             # Environment variable templates
│   ├── .env                     # REPLACE with your values (never committed)
│   ├── package.json             # Dependencies: express, ollama, pg, zod, bcors, ws
│   ├── live-test.js             # Comprehensive smoke test script
│   ├── trace.js                 # Pipeline tracer (console + stream events)
│   └── routes/                  # API route handlers
│
├── frontend/                    # Next.js UI
│   ├── app/                     # Next.js app router
│   │   ├── page.tsx             # Chat UI
│   │   ├── api/                 # API route handlers (auth, search, assist)
│   │   └── auth/                # Auth routes (register, login, logout, me)
│   ├── .env.local               # Frontend env (renamed from .env.example)
│   ├── package.json             # Dependencies: next, react, 19.x
│   ├── tailwind.config.mjs      # Tailwind CSS config
│   └── tsconfig.json            # TypeScript config
│
├── mcp/                         # Model Context Protocol server
│   ├── index.js                 # MCP server entry point
│   ├── tools.js                 # All MCP tools (get_order, list_orders, check_stock, etc.)
│   ├── auth.js                  # Authentication (session tokens, password hashing)
│   ├── db.js                    # PostgreSQL pool setup
│   ├── scripts/
│   │   └── create-admin.js      # Offline admin promotion script
│   ├── .env.example             # Environment variable templates
│   └── package.json             # Dependencies: @modelcontextprotocol/sdk, pg, bcrypt, zod
│
└── scripts/                     # Project scripts (create-admin, etc.)
```

---

## 🚀 Usage Examples

### Order Status Query (fast-path, no LLM)

```bash
curl -X POST http://localhost:5000/api/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"where is order ORD-1001"}'
```

Response includes `X-Cache: MISS` first time, then `L1_MEMORY`/`L2_POSTGRES` on repeats.

### Generic Question (LLM answer, cached)

```bash
curl -X POST http://localhost:5000/api/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"how long does a refund take to show up"}'
```

First request hits Ollama (~61s on CPU), answer is cached in PostgreSQL.

### Product Search

```bash
curl -X POST http://localhost:5000/api/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"USB-C Hub"}'
```

### MCP Tool Call (STDIO example)

```bash
# After starting mcp/index.js with MCP_AUTH_TOKEN set:
# The client calls login, then uses tools like get_order, check_stock, etc.
```

---

## 🛡️ Security Notes

- **Never commit real `.env` files** — they are listed in `.gitignore`
- **Database passwords and API keys** go in `backend/.env`, `frontend/.env.local`, `mcp/.env` only
- **Auth tokens** are verified against the database per request — never trust client-supplied identities
- **Order ownership** is enforced in SQL itself (`user_id` column) — users can only see their own orders
- **Credential guard**: Queries containing email addresses or digits have a 60-second cache TTL to prevent leaking personal data

---

## 📦 What's Included as a Client Deliverable

✅ **Complete source code** — all TypeScript, JavaScript, and config files  
✅ **Environment configuration templates** — `.env.example` for all three components  
✅ **Database schema** — auto-creating `schema.js` with pgvector, all tables, indexes  
✅ **Installation guide** — step-by-step setup from prerequisites to running  
✅ **Configuration guide** — STDIO vs Streamable HTTP transport, all environment variables  
✅ **Authentication setup** — register/login/logout flow for both HTTP and STDIO transports  
✅ **Docker configuration** — `docker-compose.yml` and `Caddyfile` for single-origin deployment  
✅ **Live test script** — `backend/live-test.js` for verifying a running deployment  
✅ **MCP tool definitions** — full tool descriptions, input schemas, and handlers  
✅ **Pipeline tracing** — console-level and streamed trace events for debugging  
✅ **Cache strategy** — L1 in-memory, L2 PostgreSQL exact match, L2 semantic (pgvector)  
✅ **Order fast-path** — DB-backed status queries without LLM calls  
✅ **Documentation** — this README.md with all the above  

---

## 🔄 Release & Maintenance

### Adding new environment variables

1. Add the variable to the appropriate `.env.example`
2. Document it in the tables above
3. If it affects backend logic, add handling in `backend/server.js`

### Schema migrations

1. Edit `backend/schema.js` for table/column changes
2. Run `docker compose up --build` to re-create containers
3. Existing data is preserved; new columns default to null unless migration script adds defaults

### Updating the Ollama model

1. Pull the new model: `ollama pull <new-model-name>`
2. Update `OLLAMA_MODEL` in `backend/.env`
3. Restart the backend: `npm run dev` (or restart the Docker container)

---

*Generated as a client deliverable for OpsMate — an operations assistant for e-commerce support teams.*