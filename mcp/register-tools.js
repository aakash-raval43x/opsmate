// register-tools.js
//
// PURPOSE:
// This file registers all MCP tools and provides common logging,
// execution-time tracking, and authentication-context handling.
//
// WHY THIS FILE IS SHARED:
// Both stdio (index.js) and Streamable HTTP (http-server.js)
// can use the same tool definitions and registration logic.
//
// IMPORTANT:
// User identity and role must come from the trusted authentication
// context, NOT from tool arguments.

// ============================================================
// 1. Generate a short ID for each tool call
// ============================================================

// WHY:
// When multiple tools execute, a unique-looking ID helps us match
// the start log with its corresponding completion or error log.
//
// NOTE:
// This short random ID is for debugging, not security or guaranteed
// uniqueness.

const newCallId = () => Math.random().toString(36).slice(2, 6);

// ============================================================
// 2. Clean and shorten text for logging
// ============================================================

// WHY:
// Long messages and multiple line breaks make terminal logs difficult
// to read. This function converts text into one readable line and
// truncates it when it exceeds the maximum length.

const oneLine = (value, max = 100) => {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

// ============================================================
// 3. Format tool arguments for logging
// ============================================================

// WHY:
// Shows which arguments were supplied when a tool was called.
//
// SECURITY:
// Some sensitive arguments are excluded from logs. Extend this
// filtering for every sensitive field used by your application.
//
// IMPORTANT:
// Do not log passwords, access tokens, session tokens, or other
// credentials. Consider sanitizing nested objects as well.

const formatArgs = (args) =>
  Object.entries(args || {})
    .filter(([key]) => !["password", "token", "session_token"].includes(key))
    .map(
      ([key, value]) =>
        `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
    )
    .join(", ");

// ============================================================
// 4. Create a short summary of a tool result
// ============================================================

// WHY:
// Tool responses may contain large JSON objects or arrays.
// Logging the entire response can make logs noisy and expose
// unnecessary customer or business data.
//
// This function produces a short summary for debugging instead.

function summarizeResult(name, result) {
  const text = result?.content?.[0]?.text || "";

  // If the tool returned an MCP error result, summarize the error.
  if (result?.isError) {
    return oneLine(text) || "error";
  }

  // No text content means there is nothing useful to summarize.
  if (!text) {
    return "ok";
  }

  try {
    // Parse the tool's text as JSON to inspect its structure.
    const data = JSON.parse(text);

    // For arrays, show the number of returned rows.
    if (Array.isArray(data)) {
      return `${data.length} row(s)`;
    }

    // For get_order, show the order ID, status, and item count.
    if (name === "get_order") {
      return [
        data.order_id,
        data.status,
        Array.isArray(data.items) ? `${data.items.length} item(s)` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }

    // For product or stock responses, show the SKU and stock count.
    if (data.sku) {
      return [
        data.sku,
        data.stock_quantity != null ? `stock ${data.stock_quantity}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }

    // For other JSON responses, return a shortened version.
    return oneLine(text);
  } catch (_error) {
    // If the response is not valid JSON, summarize it as plain text.
    return oneLine(text);
  }
}

// ============================================================
// 5. Wrap a tool handler with tracing and context handling
// ============================================================

// WHY:
// This function wraps the actual tool handler so every tool call
// gets consistent logging, execution-time measurement, and access
// to the current authentication context.
//
// IMPORTANT:
// This wrapper does not itself implement authentication or
// authorization. The context resolver and tool handlers must
// perform the appropriate checks.

function wrapTraced(
  name,
  description,
  inputSchema,
  handler,
  resolveContext,
  logLine,
) {
  // Return the wrapped function that the MCP server will execute
  // when a client calls this tool.
  return async (args) => {
    const callId = newCallId();
    const startedAt = Date.now();
    const label = name.padEnd(16);

    // Log the start of the tool call and its sanitized arguments.
    logLine(`[${callId}] ▸ ${label} ${oneLine(formatArgs(args), 96)}`);

    try {
      // WHY:
      // Obtain the current user's trusted authentication context.
      // The transport provides this resolver.
      const context = await resolveContext();

      // Execute the real tool handler with its input arguments
      // and authentication context.
      const result = await handler(args || {}, context);

      // Calculate how long the tool took to execute.
      const ms = Date.now() - startedAt;

      // Determine whether the returned MCP result indicates an error.
      const ok = result?.isError !== true;

      // Log the outcome, execution time, and short result summary.
      logLine(
        `[${callId}] ${ok ? "✓" : "✗"} ${label} ${ms}ms · ${summarizeResult(name, result)}`,
      );

      // Return the original result to the MCP SDK/client.
      return result;
    } catch (error) {
      // Log unexpected exceptions and their execution time.
      logLine(
        `[${callId}] ✗ ${label} ${Date.now() - startedAt}ms · failed: ${oneLine(error?.message || error)}`,
      );

      // Re-throw the error so the surrounding SDK/runtime can
      // handle it according to its error-handling behavior.
      throw error;
    }
  };
}

// ============================================================
// 6. Define the canonical list of MCP tools
// ============================================================

// WHY:
// Keeps all tool names, descriptions, input schemas, and handlers
// in one central list.
//
// Each tool needs:
// - name: The name exposed to MCP clients.
// - description: Explains what the tool does.
// - inputSchema: Defines accepted arguments.
// - handler: Implements the actual operation.
//
// IMPORTANT:
// Listing a tool here does not implement its permissions.
// Authorization must be enforced by the actual handler.

function buildToolDefs(tools) {
  return [
    // Authentication tools
    {
      name: "register",
      description: tools.registerDescription,
      inputSchema: tools.registerInputSchema,
      handler: tools.registerHandler,
    },
    {
      name: "login",
      description: tools.loginDescription,
      inputSchema: tools.loginInputSchema,
      handler: tools.loginHandler,
    },
    {
      name: "logout",
      description: tools.logoutDescription,
      inputSchema: tools.logoutInputSchema,
      handler: tools.logoutHandler,
    },
    {
      name: "whoami",
      description: tools.whoamiDescription,
      inputSchema: tools.whoamiInputSchema,
      handler: tools.whoamiHandler,
    },

    // Product tools
    {
      name: "list_products",
      description: tools.listProductsDescription,
      inputSchema: tools.listProductsInputSchema,
      handler: tools.listProductsHandler,
    },
    {
      name: "search_products",
      description: tools.searchProductsDescription,
      inputSchema: tools.searchProductsInputSchema,
      handler: tools.searchProductsHandler,
    },
    {
      name: "check_stock",
      description: tools.checkStockDescription,
      inputSchema: tools.checkStockInputSchema,
      handler: tools.checkStockHandler,
    },

    // Order tools
    {
      name: "get_order",
      description: tools.getOrderDescription,
      inputSchema: tools.getOrderInputSchema,
      handler: tools.getOrderHandler,
    },
    {
      name: "list_orders",
      description: tools.listOrdersDescription,
      inputSchema: tools.listOrdersInputSchema,
      handler: tools.listOrdersHandler,
    },
    {
      name: "create_order",
      description: tools.createOrderDescription,
      inputSchema: tools.createOrderInputSchema,
      handler: tools.createOrderHandler,
    },

    // Admin-only tool: authorization must be checked in its handler.
    {
      name: "update_stock",
      description: tools.updateStockDescription,
      inputSchema: tools.updateStockInputSchema,
      handler: tools.updateStockHandler,
    },
  ];
}

// ============================================================
// 7. Register every tool with the MCP server
// ============================================================

// THIS IS THE MAIN REGISTRATION FUNCTION.
//
// WHY:
// MCP clients need the server to register its tools so they can
// discover them through tools/list and invoke them through tools/call.
//
// HOW:
// 1. Build the list of tool definitions.
// 2. Iterate through each definition.
// 3. Wrap its handler with logging and context handling.
// 4. Call server.tool() to register the tool with the SDK.
//
// The server instance is provided by the transport setup.

function registerAllTools(server, tools, resolveContext, logLine = () => {}) {
  for (const { name, description, inputSchema, handler } of buildToolDefs(
    tools,
  )) {
    server.tool(name, description,inputSchema,
      wrapTraced(
        name,
        description,
        inputSchema,
        handler,
        resolveContext,
        logLine,
      ),
    );
  }
}

// ============================================================
// 8. Export functions for other files
// ============================================================

// WHY:
// CommonJS module.exports makes these functions available to
// index.js, http-server.js, and tests.
//
// Both transports can reuse the same registration logic instead
// of maintaining separate copies.

module.exports = {
  buildToolDefs,
  registerAllTools,
  wrapTraced,
  formatArgs,
  oneLine,
  summarizeResult,
};
