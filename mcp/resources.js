// resources.js
//
// The COMPANY POLICY MCP RESOURCE (single source of truth).
//
// WHY THIS EXISTS:
// The backend's system prompt tells the model to ground policy answers in
// "the policy information supplied in the conversation context from the
// company's Policy Resource" — but no resource was ever registered and no
// backend code ever read the policy document into the model context, so
// policy questions ("what is the standard return window?") went to the
// LLM with NO policy data at all and drifted into search_products or
// invented values like "14 days".
//
// This module is that resource's LOADER. register-resources.js registers it
// with BOTH MCP transports (mcp/index.js stdio for Claude Desktop / Inspector
// and mcp/http-server.js Streamable HTTP), and backend/server.js reads the
// SAME loader when it grounds a policy question — so the resource content an
// MCP client reads and the content the Ollama model is given are guaranteed
// to be identical (docs/policy.md).
//
// The document is re-read on a short TTL so a policy edit shows up within
// a minute without a server restart; on a read failure the last good copy
// keeps serving and a null return tells callers the resource is unavailable.

const fs = require('fs');
const path = require('path');

const POLICY_URI = 'opsmate://company/policy';
const POLICY_NAME = 'company-policy';
const POLICY_TITLE = 'OpsMate Company Policy';
const POLICY_MIME_TYPE = 'text/markdown';

const POLICY_FILE = process.env.POLICY_FILE
  ? path.resolve(process.env.POLICY_FILE)
  : path.join(__dirname, '..', 'docs', 'policy.md');

// Set on a successful load so 'Policy Content not found' must never happen:
// This ensures the backend does not inject stale/unreadable text.
const TTL = Number(process.env.POLICY_CACHE_TTL_MS || 60000);

let cachedText = null;      // last successfully loaded document (or null)
let cachedAt = 0;           // when cachedText was read
let lastErrorMessage = null;

/**
 * Read one document text from disk, using the cache entry within TTL.
 * @returns {string} the policy markdown (may be empty string if unavailable)
 */
function getPolicyDocument() {
  if (cachedText !== null && Date.now() - cachedAt < TTL) {
    return cachedText;
  }
  try {
    const text = fs.readFileSync(POLICY_FILE, 'utf-8');
    cachedText = text;
    cachedAt = Date.now();
    lastErrorMessage = null;
  } catch (error) {
    lastErrorMessage = `policy document unavailable: ${error.message}`;
    cachedText = '';
    cachedAt = Date.now();
  }
  return cachedText;
}

/**
 * Up-to-date policy CONTENT for the MCP resource callback and the backend.
 * @returns {{ text: string, available: boolean } | null} null only when no
 *   document could ever be loaded (the resource is genuinely unreadable).
 */
function getPolicyConfig() {
  const text = getPolicyDocument();
  return {
    text,
    available: text.length > 0,
    lastErrorMessage,
  };
}

// NOTE: registration lives in register-resources.js (shared by both MCP
// transports) so there is exactly ONE server.resource() code path; this file
// stays the single loader both that module and backend/server.js depend on.

module.exports = {
  POLICY_URI,
  POLICY_NAME,
  POLICY_TITLE,
  POLICY_MIME_TYPE,
  getPolicyDocument,
  _test: {
    getPolicyConfig,
    POLICY_FILE,
  },
};
