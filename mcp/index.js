require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { createAuth } = require('./auth');
const pool = require('./db');
const { createTools } = require('./tools');
const { registerAllTools } = require('./register-tools');               //npx @modelcontextprotocol/inspector node index.js 
const { registerAllResources } = require('./register-resources');

// ======================================================
// STDIO-SAFE LOGGING
// STDOUT is reserved for MCP JSON-RPC messages.
// All diagnostic logs must go to STDERR.
// Passwords, tokens and session identifiers are NEVER logged.
// ======================================================

const logLine = (line) => process.stderr.write(`${line}\n`);

// ======================================================
// AUTH CONTEXT RESOLUTION (stdio)
//
// Identity is established ONLY from:
//   1. MCP_AUTH_TOKEN in this process's environment (configured by the
//      trusted local user in e.g. claude_desktop_config.json or MCP
//      Inspector environment settings), verified against the database.
//   2. A session this same client created by calling the `login` tool in
//      the current process lifetime (server-held in-process state).
//
// Anything else — tool arguments, LLM output — establishes nothing.
// Resolution fails closed: an unverifiable or expired token means no
// context, and every protected tool rejects the call as unauthenticated.
// ======================================================

const auth = createAuth(pool); // aa line run krvathi auth.js file mathi jetla function return thay chhe e badha auth object ma store thay chhe.

const tools = createTools(pool, auth); // aa line run krvathi tools.js file mathi jetla function return thay chhe e badha tools object ma store thay chhe.

async function resolveStdioContext() {
  const rawToken = (typeof process.env.MCP_AUTH_TOKEN === 'string' && process.env.MCP_AUTH_TOKEN.trim()) || tools.getActiveTokenRaw();

  if (rawToken) {
    return await auth.resolveSessionToken(rawToken);
  }
  return null;
}

// ======================================================
// CREATE SERVER AND REGISTER TOOLS
// ======================================================

const server = new McpServer({
  name: 'opsmate-order-inventory',
  version: '1.1.0',
});

registerAllTools(server, tools, resolveStdioContext, logLine); //purpose of this line is to register all the tools with the MCP server. It takes the server instance, the tools object, a function to resolve the context for stdio, and a logging function as arguments. This allows the server to handle requests for the registered tools and log relevant information about their usage.

registerAllResources(server, logLine); 

// ======================================================
// START MCP SERVER
// ======================================================

async function main() {
  // Validate that the configured database is reachable before connecting MCP.
  await pool.query('SELECT 1');

  logLine('[mcp] PostgreSQL connection successful'); // aa line run krvathi database connection successful message stderr ma print thay chhe.

  const transport = new StdioServerTransport(); //StdioServerTransport class no instance create thay chhe. aa class stdio transport handle kare chhe.
  await server.connect(transport);

  const authMode = process.env.MCP_AUTH_TOKEN ? 'env token' : 'login tool / unset';

  logLine(
    `[mcp] OpsMate order/inventory server ready (stdio, auth: ${authMode}) — register, login, logout, whoami, get_order, list_orders, create_order, list_products, check_stock, search_products, update_stock`
  );
}

main().catch((error) => {
  logLine(
    `[mcp] MCP server failed to start: ${require('./register-tools').oneLine(error?.stack || error, 500)}`
  );
  process.exitCode = 1;
});
