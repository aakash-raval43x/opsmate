# OpsMate — Order & Inventory MCP Server

A standalone [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that exposes five order and inventory tools over the existing OpsMate PostgreSQL database.

It runs as a separate process and can connect to Claude Desktop, MCP Inspector, and other MCP-compatible clients that support stdio transport.

**Repository:** https://github.com/aakash-raval43x/opsmate

## Features

- **Authentication:** registration, login, logout with bcrypt password hashing and opaque, database-backed session tokens (only SHA-256 token hashes are stored).
- **Authorization:** every tool call is resolved to a server-verified identity; normal users can only ever see their own orders, admins see all orders and may update stock. Ownership filters are applied inside the SQL queries themselves.
- Retrieve complete order details.
- List orders with optional status filtering and pagination.
- Create orders with transactional stock reservation (no overselling).
- List products, check current product stock.
- Search products by name or SKU.
- Admin-only stock updates that never go negative.
- PostgreSQL integration using a connection pool.
- Input validation (Zod) and string sanitization.
- Stdio transport **and** Streamable HTTP transport with per-request Bearer authentication.

## Project Structure

```text
opsmate/
├── backend/                   # Express chat backend (reuses mcp/tools.js handlers)
├── frontend/                  # Next.js frontend
├── mcp/
│   ├── .env                   # Database configuration (not committed)
│   ├── index.js               # MCP stdio entry point + auth context resolution
│   ├── http-server.js         # Streamable HTTP entry point (Bearer auth)
│   ├── db.js                  # PostgreSQL connection pool
│   ├── auth.js                # bcrypt auth, sessions, role authorization helpers
│   ├── tools.js               # Tool descriptions, Zod schemas, secured handlers
│   ├── register-tools.js      # Shared tool registration for both transports
│   ├── auth-test-helpers.js   # Trusted test fixtures
│   ├── auth-test.js           # Authentication/authorization test suite (16 tests)
│   ├── smoke-test.js          # End-to-end test over the real transports
│   ├── advanced-test.js       # MCP tool tests (existing suite, admin fixture)
│   ├── scripts/
│   │   └── create-admin.js    # TRUSTED admin bootstrap (the only admin path)
│   ├── package.json           # MCP dependencies
│   ├── package-lock.json
│   └── README.md              # MCP server documentation
├── docker-compose.yml
├── .gitignore
└── README.md
```

## Requirements

- Node.js and npm
- PostgreSQL
- The OpsMate database and required tables
- Claude Desktop or MCP Inspector for testing

## Installation and Configuration

### 1. Open the MCP directory

Run these commands in PowerShell:

```powershell
cd "D:\Raval Aakash\intership-task\opsmate\mcp"
npm install
```

### 2. Configure the database

Create a `.env` file inside the `mcp/` directory:

```env
DATABASE_URL=postgresql://opsmate:opsmate_password@127.0.0.1:5432/opsmate
```

Replace the connection values with the configuration for your PostgreSQL database if they differ.

**Important:** Keep `.env` private. Never commit database passwords or other secrets to GitHub.

### 3. Start the MCP server

```powershell
node index.js
```

The server initializes its PostgreSQL connection and starts using stdio transport.

When running through Claude Desktop or MCP Inspector, the client launches the MCP process automatically. You do not need to start a separate HTTP server for this MCP connection.

## MCP Tools

| Tool | Inputs | Access | Description |
|---|---|---|---|
| `register` | `name`, `email`, `password` | public | Creates an account. **Always role `user`**, regardless of any arguments sent. |
| `login` | `email`, `password` | public | Verifies credentials server-side and issues an opaque session token. |
| `logout` | — | authenticated | Revokes the current session; later calls fail closed. |
| `whoami` | — | authenticated | Shows the verified identity, role, and access scope. |
| `get_order` | `order_id: string` | authenticated | Retrieves an order — user: **only own orders**; admin: any order.foreign orders are reported as `Order not found` (no existence leak). |
| `list_orders` | `status?`, `limit?`, `offset?` | authenticated | User: own orders only. Admin: all orders including legacy unowned ones. |
| `create_order` | `items: [{ sku, quantity }]` | authenticated | Creates an order for the **authenticated caller** with trusted DB prices and a transactional stock reservation. Any `user_id` in the arguments is ignored. |
| `list_products` | `limit?: number` | authenticated | Active products with public fields only. |
| `check_stock` | `sku: string` | authenticated | Retrieves current stock and product active status. |
| `search_products` | `query: string`, `limit?: number` | authenticated | Searches products by full or partial name, or SKU. |
| `update_stock` | `sku: string`, `quantity: number` | **admin only** | Normal users receive `Permission denied`. Stock can never go negative. |

String inputs are sanitized by the helper in `tools.js` to handle common formatting issues, such as surrounding quotes and stray key prefixes.

## Authentication & Authorization

### Identity model

- Passwords are hashed with **bcrypt** (cost 12). Plaintext passwords are never stored or logged.
- Sessions are opaque random tokens; only a **SHA-256 hash** is stored in the `sessions` table, with expiry and instant revocation (logout deletes the row).
- The verified identity `{ userId, email, role }` is built **only** from a valid DB-backed session. Tool arguments, model output, and client headers never establish identity or role.
- Authorization fails closed: no session → every protected tool answers `Authentication required`.
- Public registration always produces role `user`. Admin is granted **only** by the trusted offline script (below) — never through the MCP protocol.

### How identity is established for each client

**Stdio (Claude Desktop, MCP Inspector):** a stdio process serves exactly one local user. Put a valid session token in the client's environment as `MCP_AUTH_TOKEN`, or call the `login` tool once in that client session (the server remembers the verified session per process). For Claude Desktop, add `"env": { "MCP_AUTH_TOKEN": "ops_…" }` to the `mcpServers` entry. A web application's login does NOT authenticate Claude Desktop — each client establishes its own identity.

**Streamable HTTP (multiple remote users):** start `node http-server.js` (default `http://0.0.0.0:3002/mcp`, configurable via `MCP_HTTP_PORT`/`MCP_HTTP_HOST`). Every request must carry `Authorization: Bearer <session token>`; the token is verified against the database per request, so each remote user authenticates independently and revocation is immediate. Only `register` and `login` are reachable without a token (identity bootstrapping); anything else returns 401.

> OAuth note: the MCP Streamable HTTP OAuth flow (RFC 8414 metadata + PKCE with a dedicated authorization server) is the standard multi-user deployment option; this server implements the same trust model with first-party bearer tokens verified server-side per request. Swapping in an OAuth identity provider later only requires replacing the token resolver in `http-server.js`.

### Admin creation (trusted administrative process)

```bash
# password comes from the environment — never from code or prompts
ADMIN_PASSWORD='your-secret' node mcp/scripts/create-admin.js --name "Ops Admin" --email admin@example.com --token
```

- `--token` additionally prints an `MCP_AUTH_TOKEN=ops_…` line for client configuration.
- `--email <existing user> --promote` promotes an existing account to admin after an interactive confirmation.
- `--ttl-days N` sets a longer session validity for machine/service accounts.

### Backend (chat) service integration

`backend/server.js` reuses the same tool handlers. The dedicated service account (an `MCP_SERVICE_TOKEN` in `backend/.env`) is only a FALLBACK for callers that send no Bearer token at all. When a web/chat request carries the browser's session token, the backend resolves it to a VERIFIED identity and every tool call runs as THAT user: normal users see only their own orders and are denied `update_stock`; admins see all orders. A token that is present but invalid/expired is rejected with 401 — it is never silently widened to the service account. The service token is still re-verified against the database for every fallback tool call, so expiry or revocation applies at once.

### Legacy orders with `user_id = NULL`

The three pre-existing orders (ORD-1001…1003) predate accounts and are **not** assigned to any user. They are ignored by user-scoped queries and remain visible to **admins only**. They can be claimed one-by-one by an admin using a deliberate ownership backfill (`UPDATE … SET user_id`) when the real owner is known — no automatic assignment. New orders created through `create_order` are always owned by the authenticated user.

## Testing with MCP Inspector

MCP Inspector provides a browser interface for connecting to the MCP server and testing its tools.

From the `mcp/` directory, run:

```powershell
npx @modelcontextprotocol/inspector node index.js
```

Use the Inspector interface to connect to the server and invoke each tool with its required inputs.

### Example tool inputs

**Get an order**

```json
{
  "order_id": "ORD-1001"
}
```

**List orders**

```json
{
  "limit": 20
}
```

**Check stock**

```json
{
  "sku": "SKU-001"
}
```

**Search products**

```json
{
  "query": "Wireless Mouse"
}
```

**Increase stock by one unit**

```json
{
  "sku": "SKU-001",
  "quantity": 1
}
```

**Important:** `update_stock` changes the database. Use it only when you intend to change inventory.

### Run automated tests

```powershell
# authentication & authorization suite (all 14 required security scenarios)
node --test auth-test.js

# existing tool suite (runs as a trusted admin fixture)
node --test advanced-test.js

# live end-to-end verification over BOTH transports (stdio + HTTP)
node smoke-test.js
```

Run these commands from the `mcp/` directory. `auth-test.js` creates its own fixture users and restores stock afterwards; `advanced-test.js` already covers the pre-existing tool expectations. Nothing in either suite requires mutation-test opt-in anymore except the idempotent stock restore.

## Claude Desktop Configuration

The MCP server has been connected and tested with Claude Desktop.

Open the Claude Desktop configuration file:

```text
C:\Users\alian\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json
```

Add the following entry inside the existing `mcpServers` object:

```json
{
  "mcpServers": {
    "opsmate-orders": {
      "command": "node",
      "args": [
        "D:\\Raval Aakash\\intership-task\\opsmate\\mcp\\index.js"
      ]
    }
  }
}
```

**Configuration notes:**

- Merge this entry into the existing configuration; do not delete unrelated settings.
- Use the actual absolute path to `mcp/index.js` on your computer.
- Restart Claude Desktop after saving the configuration.
- Confirm that the server connects, then test its tools in a conversation.

## Database Schema

The MCP server uses these tables in the OpsMate PostgreSQL database:

| Table | Purpose |
|---|---|
| `orders` | Order details, customer, status, total amount, and creation date. |
| `products` | Product SKU, name, description, price, stock, and active status. |
| `order_items` | Products and quantities associated with each order. |

The chat backend's `queries` and `query_cache` tables are separate from the MCP tools' main order and inventory operations.

## Example Results

The examples below illustrate the tool response fields. Stock quantities can change after an inventory update.

**`get_order`**

```json
{
  "order_id": "ORD-1001",
  "customer_name": "Aakash",
  "status": "shipped",
  "total_amount": "1499.00",
  "items": [
    {
      "sku": "SKU-001",
      "name": "Wireless Mouse",
      "quantity": 2,
      "unit_price": "499.00"
    },
    {
      "sku": "SKU-002",
      "name": "Mechanical Keyboard",
      "quantity": 1,
      "unit_price": "2499.00"
    }
  ]
}
```

**`check_stock`**

The last verified result for `SKU-001` was:

```json
{
  "sku": "SKU-001",
  "name": "Wireless Mouse",
  "stock_quantity": 56,
  "is_active": true
}
```

**`search_products`**

```json
[
  {
    "sku": "SKU-001",
    "name": "Wireless Mouse",
    "price": "499.00",
    "stock_quantity": 56,
    "is_active": true
  }
]
```

**`update_stock`**

The tool accepts a signed quantity. For example, adding one unit to a stock of 55 should result in 56 units if the update succeeds.

```json
{
  "sku": "SKU-001",
  "quantity": 1
}
```

Always check the returned result or call `check_stock` again to verify the actual database value.

**Data consistency note:** The sample `ORD-1001` has a recorded total of ₹1,499, but its listed line items add up to ₹3,497. This is an inconsistency in the sample order data that should be corrected separately; it does not by itself indicate an MCP connection failure.

## Logging and Troubleshooting

The server uses stderr for diagnostic logging. With stdio transport, stdout is reserved for MCP protocol messages and must not contain ordinary debug logs.

If the server fails to connect:

1. Verify that PostgreSQL is running and the database is reachable.
2. Check the `DATABASE_URL` in `mcp/.env`.
3. Confirm that `index.js` and `db.js` load the correct `.env` file.
4. Confirm that Claude Desktop points to `mcp/index.js`, not the Express backend's `server.js`.
5. Restart Claude Desktop after editing its configuration.
6. Run the MCP Inspector to isolate connection or tool errors.

## Scope and Limitations

- **Authentication and authorization:** Implemented (bcrypt password hashing, DB-backed sessions, per-call verification, User/Admin roles, SQL-level ownership filters). Admin only via the trusted bootstrap script.
- **Inventory audit history:** Not implemented. Stock is updated directly; no stock-change history is maintained.
- **OAuth authorization server:** Not deployed. Streamable HTTP uses first-party opaque Bearer tokens verified per request; swapping in an OAuth provider is a resolver change in `http-server.js`.
- **Legacy order ownership backfill:** Deliberately not automated.

## Current Status

- [x] PostgreSQL connection configured
- [x] Eleven MCP tools implemented (auth + orders + products + admin stock)
- [x] MCP Inspector connection and tool testing completed
- [x] Claude Desktop connection verified
- [x] `get_order`, `list_orders`, `check_stock`, and `search_products` tested
- [x] `update_stock` tested and the updated stock verified
- [x] Input sanitization implemented
- [x] Registration/login/logout with bcrypt and DB-backed sessions
- [x] User/Admin authorization enforced server-side on every tool
- [x] `create_order` with transactional, oversell-safe stock reservation
- [x] Streamable HTTP transport with per-request Bearer authentication
- [x] 16-test authorization suite + live transport smoke test passing

**Project goal:** Expose existing OpsMate order and inventory operations as reusable MCP tools that compatible AI clients can discover and invoke.
