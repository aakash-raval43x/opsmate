// http-server.js
// Streamable HTTP transport for the Order & Inventory MCP server.
//
// Multiple REMOTE users connect to this endpoint and each authenticates
// independently:
//     Authorization: Bearer <session token>
//
// The token is an opaque DB-backed session token (see auth.js) issued by the
// `login` tool or the scripts/create-admin.js bootstrap. It is verified
// against the database for EVERY request; a revoked or expired token fails
// closed with 401.
//
// Note on OAuth: the official OAuth authorization flow for Streamable HTTP
// (RFC 8414 metadata + PKCE) is a deployment-level concern with a separate
// identity provider. This server implements the same trust model with first-
// party opaque bearer tokens verified server-side per request; swapping the
// resolver only requires changes in this file's `bearerToContext`.
//
// Run: node http-server.js
// Env: MCP_HTTP_PORT (default 3002), MCP_HTTP_HOST (default 0.0.0.0)

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const http = require('http');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const { createAuth } = require('./auth');
const pool = require('./db');
const { createTools } = require('./tools');
const { registerAllTools, oneLine } = require('./register-tools');
const { registerAllResources } = require('./register-resources');

// ======================================================
// STDERR-SAFE LOGGING (stdout is not needed for HTTP)
// Never logs tokens, passwords or session ids.
// ======================================================
const logLine = (line) => process.stderr.write(`${line}\n`);

const PORT = Number(process.env.MCP_HTTP_PORT || 3002);
const HOST = process.env.MCP_HTTP_HOST || '0.0.0.0';

const auth = createAuth(pool);

// ======================================================
// BEARER -> VERIFIED CONTEXT (the only identity path)
// ======================================================
async function bearerToContext(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return null;
  }

  // Review against the DB; errors inside resolveSessionToken fail closed.
  return await auth.resolveSessionToken(match[1].trim());
}

const UNAUTHORIZED_BODY = JSON.stringify({
  jsonrpc: '2.0',
  error: {
    code: -32001,
    message: 'Authentication required: send Authorization: Bearer <session token>',
  },
  id: null,
});

function respondUnauthorized(res) {
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Bearer',
  });
  res.end(UNAUTHORIZED_BODY);
}

// ======================================================
// STATELESS MCP HANDLING
// Each POST creates one stateless transport + server and attaches the
// verified context for that specific request. No cross-request session
// state is shared between different users.
// ======================================================
async function handlePost(req, res, body) {
  const server = new McpServer({
    name: 'opsmate-order-inventory',
    version: '1.1.0',
  });

  const tools = createTools(pool, auth);

  // Bearer resolution happens HERE, once, against the parsed body so we can
  // whitelist the two identity-bootstrapping tools. register/login run with
  // NO context; every other call without a verified token is rejected.
  const context = await bearerToContext(req);

  if (!context) {
    const methodName = body?.method;
    const toolName = body?.params?.name;
    const bootstrapAllowed =
      (methodName === 'tools/call' && (toolName === 'register' || toolName === 'login')) ||
      methodName === 'initialize' ||
      (methodName || '').startsWith('notifications/');

    if (!bootstrapAllowed) {
      respondUnauthorized(res);
      return;
    }
  }

  const finalContext = context ?? null;

  // Reclose over the ALREADY-verified context: the resolver itself must not
  // re-run per tool call and must not trust anything sent per call.
  registerAllTools(server, tools, async () => finalContext, logLine);

  // RESOURCES (currently: Company Policy opsmate://company/policy) — the full
  // document is readable by every MCP client over Streamable HTTP too, via the
  // same registration module the stdio (Claude Desktop) transport uses.
  registerAllResources(server, logLine);

  // Stateless mode: no session ids, no cross-request state.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on('close', () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

const httpServer = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      // Unauthenticated liveness probe; reveals no data.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && req.url.startsWith('/mcp')) {
      // Collect and parse the JSON body first — auth gating needs the method
      // and tool name.
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
        if (chunks.reduce((sum, c) => sum + c.length, 0) > 1024 * 1024) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Payload too large' }, id: null }));
          return;
        }
      }

      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch (_parseError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
        return;
      }

      await handlePost(req, res, body);
      return;
    }

    // GET/DELETE /mcp (SSE streams, session deletion) are not used in
    // stateless JSON mode; reject everything else explicitly.
    if (req.url && req.url.startsWith('/mcp')) {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (error) {
    logLine(`[mcp-http] request failed: ${oneLine(error?.message || error, 200)}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
    } else {
      res.end();
    }
  }
});

// ======================================================
// STARTUP
// ======================================================
async function main() {
  await pool.query('SELECT 1');
  logLine(`[mcp-http] PostgreSQL connection successful`);

  httpServer.listen(PORT, HOST, () => {
    logLine(
      `[mcp-http] OpsMate order/inventory MCP server ready on http://${HOST}:${PORT}/mcp (Streamable HTTP, Bearer auth). Call login (stdio or scripts/create-admin.js) to obtain a token.`
    );
  });
}

main().catch((error) => {
  logLine(`[mcp-http] failed to start: ${oneLine(error?.stack || error, 500)}`);
  process.exitCode = 1;
});
