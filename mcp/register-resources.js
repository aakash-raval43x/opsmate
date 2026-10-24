// register-resources.js
//
// PURPOSE:
// This file registers all MCP RESOURCES with an McpServer and provides
// common read-time logging/tracing.
//
// WHY THIS FILE IS SHARED:
// Both transports — stdio (index.js, used by Claude Desktop and the MCP
// Inspector) and Streamable HTTP (http-server.js, used by remote clients)
// — register the SAME resources with the SAME read logic, so an MCP client
// always sees exactly the document the backend grounds its answers on.
//
// DIVISION OF LABOUR:
// - resources.js is the LOADER (reads docs/policy.md with a TTL cache).
// - register-resources.js is the REGISTRATION LAYER (server.resource calls,
//   read tracing) — the same split as tools.js (implementation) and
//   register-tools.js (server.tool calls).
//
// IMPORTANT:
// Resources are read-only company documents. They contain NO user data and
// need no per-caller identity — any authenticated MCP client may read them.

const {
  POLICY_URI,
  POLICY_NAME,
  POLICY_TITLE,
  POLICY_MIME_TYPE,
  _test: { getPolicyConfig },
} = require('./resources');

// ============================================================
// 1. Wrap a resource read handler with tracing
// ============================================================
//
// WHY:
// Resource reads are rare (a client reads the policy once per session),
// so a compact start/finish log line is enough to debug "did the client
// actually receive the document?" without any noise.

function wrapTracedResource(name, uri, read, logLine) {
  return async (requestUri) => {
    const startedAt = Date.now();
    const result = await read(requestUri);
    const chars = result?.contents?.[0]?.text?.length ?? 0;
    logLine(
      `[resource] ✓ ${name.padEnd(16)} ${uri} · ${chars} char(s) · ${Date.now() - startedAt}ms`,
    );
    return result;
  };
}

// ============================================================
// 2. Define the canonical list of MCP resources
// ============================================================
//
// WHY:
// Keeps all resource names, URIs, metadata and read callbacks in one
// central list — the same pattern as buildToolDefs() in register-tools.js.
//
// Each resource needs:
// - name: The name exposed to MCP clients (resources/list).
// - uri: The stable URI a client reads (resources/read).
// - metadata: title/mimeType/description shown by clients.
// - read: Implements the actual read (delegates to the loader).

function buildResourceDefs() {
  return [
    {
      name: POLICY_NAME,
      uri: POLICY_URI,
      metadata: {
        title: POLICY_TITLE,
        mimeType: POLICY_MIME_TYPE,
        description:
          'OpsMate company policy (returns, shipping, warranty, quality guarantee). Grounding source for policy answers.',
      },
      // The loader is the SAME function backend/server.js uses, so the text
      // an MCP client reads is guaranteed identical to the model's context.
      read: async (uri) => {
        const doc = getPolicyConfig();
        if (!doc.available) {
          throw new Error(doc.lastErrorMessage || 'policy document unavailable');
        }
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: POLICY_MIME_TYPE,
              text: doc.text,
            },
          ],
        };
      },
    },
  ];
}

// ============================================================
// 3. Register every resource with the MCP server
// ============================================================
//
// WHY:
// MCP clients discover resources through resources/list and fetch them
// through resources/read; both need the server.resource() registrations.
//
// The server instance is provided by the transport setup.

function registerAllResources(server, logLine = () => {}) {
  for (const { name, uri, metadata, read } of buildResourceDefs()) {
    server.resource(
      name,
      uri,
      metadata,
      wrapTracedResource(name, uri, read, logLine),
    );
  }
  logLine(`[resource] ${buildResourceDefs().length} resource(s) registered`);
}

// ============================================================
// 4. Export for the transports
// ============================================================

module.exports = {
  buildResourceDefs,
  registerAllResources,
  wrapTracedResource,
};
