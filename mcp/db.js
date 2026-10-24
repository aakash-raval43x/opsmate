
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is missing from the MCP .env file');
}

// Same connection-churn family as the backend pool fix in backend/server.js:
// over Docker Desktop / Windows NAT an MCP server that idles between tool
// calls keeps getting its TCP connections reset (ECONNRESET on the next
// query). TCP keepAlive holds the socket open so idle tool calls reuse it
// instead of cold-connecting every time.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected PostgreSQL pool error:', err.message);
});

module.exports = pool;
