const { z } = require('zod');
const { createAuth, AuthError, ForbiddenError } = require('./auth');
//in this file we are importing the zod library and the createAuth, AuthError, and ForbiddenError functions from the auth.js file. The zod library is used for input validation and schema definition. The createAuth function is used to create an authentication object that handles user authentication and authorization. The AuthError and ForbiddenError classes are custom error types that are thrown when authentication or authorization fails.

// --------------------------------------------------
// Input sanitizer
// --------------------------------------------------
function sanitizeString(value) {    // aa function sanitizeString() string ne sanitize kare chhe. aa function ma value parameter pass thay chhe. je string ne sanitize karva mate use thay chhe. sanitize atle string ma thi unwanted characters ne remove karvu. aa function ma check thay chhe ke value string chhe ke nahi. jo value string nathi to e value return kare chhe. ane jo value string hoy to e value ne trim() method thi whitespace remove kare chhe. ane colonMatch variable ma regex match kare chhe je string ma thi unwanted prefix ne remove kare chhe. ane last ma surrounding single or double quotes ne remove kare chhe. ane finally sanitized string return kare chhe. example: "sku: SKU-001" ne sanitize karva pachi "SKU-001" return thay chhe.
  if (typeof value !== 'string') return value;

  let v = value.trim();

  // Remove prefixes such as "sku: SKU-001"
  const colonMatch = v.match(/^[a-zA-Z_]+\s*:\s*(.+)$/);
  if (colonMatch) v = colonMatch[1].trim();

  // Remove surrounding single or double quotes
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }

  return v.trim();
}

// --------------------------------------------------
// MCP result helpers
// --------------------------------------------------
const okResult = (text) => ({
  content: [{ type: 'text', text }],
});

const errResult = (text) => ({
  content: [{ type: 'text', text }],
  isError: true,
});

// --------------------------------------------------
// In-process session state (stdio convenience)
//
// stdio serves exactly ONE client per process, so when that client calls
// `login` via MCP, the issued session token is remembered server-side for
// subsequent tool calls. This is server-trusted state: the client never
// chooses its identity, it only proves it once via credentials.
//
// Over Streamable HTTP this is DISABLED; identity comes per request from the
// Authorization: Bearer token.
// --------------------------------------------------
const sessionState = {  
  rawToken: null,
};



// -------------------------------------------------- 
// Tools descriptions
const getOrderDescription = `
Retrieve complete details for one specific order using its exact business order ID.

PERMISSIONS: authenticated users can only retrieve an order that belongs to
themselves. Administrators can retrieve any order. If an order ID belongs to
another user, the tool reports it as not found - do not retry with other IDs
and do not ask the user for someone else's order.

Use this tool when the user asks about a particular order's details, status,
customer name, total amount, creation date, purchased products, product SKUs,
item quantities, or item prices recorded for that order.

Examples:
- "Show order ORD-1001."
- "Where is my order ORD-1001?"
- "What is the status of ORD-1001?"
- "Who placed this order?"
- "What products are in ORD-1001?"
- "How much did this order cost?"

Extract the actual order ID from the user's message and pass it as order_id.
Do not invent an order ID. If the user wants multiple orders or orders filtered
by status, use list_orders instead.

This tool reads one order and its items. It does not create, update, cancel,
or provide live courier tracking for orders.
`.trim();

const listOrdersDescription = `
Retrieve a list of orders, optionally filtered by status, with validated
pagination (limit and offset).

PERMISSIONS: authenticated users always see ONLY their own orders - this is
enforced by the server and cannot be overridden by any argument. Administrators
see all orders, including legacy orders with no registered owner.

Use this tool when the user asks to list, browse, find, or review multiple orders,
including all orders or orders with a specified status such as shipped,
processing, or delivered.

Examples:
- "Show all orders."
- "List shipped orders."
- "Which orders are processing?"
- "Show the latest 10 orders."
- "Find recently created orders."
- "List delivered orders with customer names and totals."

Pass status only when the user specifies a status filter.
Pass limit when the user requests a result count. The maximum limit is 100.
Pass offset to paginate further results (default 0). To get the next page of
orders, call again with the same limit plus offset = previous limit.
If omitted, the server uses its default limit.

This tool returns order summaries, not complete order items.
For details of one specific order, use get_order instead.
Do not claim that a limited result contains every order.

This tool is read-only and does not create, update, or cancel orders.
`.trim();

const createOrderDescription = `
Create a NEW order for the authenticated user from one or more products.

PERMISSIONS: this tool always creates the order for the logged-in user.
Ownership comes from the server-side authentication session - it can never be
set or spoofed by model or client arguments. Any user_id value in the arguments
is IGNORED.

Behavior:
- Each item is an exact product SKU with a quantity.
- Prices and the total are taken from the database, never from arguments.
- Stock is reserved transactionally: the order is created and inventory is
  deducted atomically. If any product lacks enough stock, nothing is saved.
- The order starts with status "processing".

Examples:
- "Create an order with 2 wireless mice."
- "I want one USB-C hub and a mechanical keyboard."
- "Order 3 units of SKU-001."

When the user names products instead of SKUs, use search_products first to
resolve exact SKUs, confirm quantities with the user, then call this tool.
Never invent prices or SKUs. If a product is inactive or stock is insufficient,
tell the user which item failed.

This tool creates orders. It does not modify existing orders, cancel orders,
or update stock directly.
`.trim();

const listProductsDescription = `
Browse the active product catalog with relevant public product information.

Use this tool when the user wants to see available products, browse the
catalog, or get an overview of products and prices.

Examples:
- "List products."
- "What products are available?"
- "Show me the catalog."

Results include SKU, name, description, price, and stock quantity for active
products only. This tool is read-only and reveals no internal data.
`.trim();

const checkStockDescription = `
Check current inventory information for one product using its exact SKU.

Use this tool when the user asks how much stock is available, the current
inventory quantity, or whether a product is active, and the exact SKU is known.

Examples:
- "Check stock for SKU-001."
- "How many units are available for SKU-001?"
- "Is SKU-001 active?"
- "Tell me the current inventory of SKU-001."

Pass the exact product SKU as sku.
If the user only provides a product name, partial name, or uncertain SKU,
use search_products first to identify the matching product.
If multiple products match, clarify which product the user means.

This tool only reads inventory. It does not change stock, reserve inventory,
or calculate stock availability after pending orders.
`.trim();

const searchProductsDescription = `
Search the product catalog by full or partial product name, exact SKU, or partial SKU.

Use this tool when the user refers to a product by name or SKU, does not know
the exact SKU, or asks for catalog information such as product price,
stock quantity, or active status.

Examples:
- "Find the USB-C Hub."
- "What is the price of the USB-C Hub?"
- "How much does a hub cost?"
- "Search for SKU-003."
- "Find products containing keyboard."
- "Show this product's price and stock."
- "I do not know the SKU; find the product for me."

Pass a concise product name, distinctive product words, or SKU as query.
Avoid passing the entire conversational question when a short search term
can be extracted. Use limit when the user requests a specific number of results.
The maximum limit is 50.

The tool can return multiple matches. Examine the returned product names
and SKUs before answering. If there is no reliable match, ask the user
to clarify instead of guessing.

Use this tool to find a product SKU before calling check_stock, update_stock,
or create_order when the SKU is unknown.

This tool reads product information. It does not modify stock or prices.
`.trim();

const updateStockDescription = `
ADMIN-ONLY: change the inventory quantity for one product identified by its
exact SKU.

PERMISSIONS: only administrators may use this tool. Normal users receive a
permission-denied response. Never claim an inventory change succeeded unless
this tool confirms it.

Use this tool only when an administrator explicitly requests an inventory change,
such as adding stock, receiving new stock, removing units, or reducing inventory.

The quantity parameter is a signed integer representing the CHANGE,
not the desired final stock quantity:
- Positive quantity adds stock. Example: +10 adds 10 units.
- Negative quantity removes stock. Example: -5 removes 5 units.
- Zero is invalid.

Examples:
- "Add 10 units to SKU-001."
- "Increase SKU-001 stock by 20."
- "Remove 5 units from SKU-001."
- "Reduce inventory of SKU-001 by 3."
- "We received 15 new units of this product."

Extract the exact SKU and requested change.
If the product is known only by name, use search_products first.
If the intended product or quantity is ambiguous, ask for clarification
before making a change.

Never use this tool for requests that only ask to check, show, find,
or report stock. Those requests are read-only and should use check_stock
or search_products.

The server prevents stock from becoming negative. It returns an error
if the product does not exist or the requested removal exceeds current stock.

This tool changes inventory in the database. It does not create orders,
reserve stock, change product prices, or create an audit entry.
`.trim();

const registerDescription = `
Create a new customer account with the USER role.

Use this tool when a person without an account wants to register.
Registration ALWAYS produces a normal user; there is no way to register as an
administrator. Role elevation happens only through a trusted administrative
process on the server.

Required inputs: name, a valid email address, and a password of at least
8 characters containing at least one letter and one digit.

After successful registration, call login with the same email and password
to obtain a session token.
`.trim();

const loginDescription = `
Authenticate with an email and password to establish this client's identity.

Call this tool when the user asks to log in, or when other tools report
"Authentication required". On success the server creates an opaque session
token that this client's later tool calls are verified against server-side.
The token itself is never accepted as an identity claim from tool arguments.

Identity and role (user or admin) are determined ONLY by the server after
verifying the credentials against the database.
`.trim();

const logoutDescription = `
End the current session so subsequent protected tool calls are no longer
authenticated.

Call this tool when the user asks to log out. After logout, tools report
"Authentication required" until a new login happens.
`.trim();

const whoamiDescription = `
Show the authentication context of this client session: who is logged in,
their role, and what data they can access.

Use this tool to diagnose permission problems, such as when the user asks
"which account am I using?" or a tool unexpectedly reports authentication
required or permission denied.
`.trim();

// --------------------------------------------------
// Input schemas
// --------------------------------------------------

const getOrderInputSchema = {
  order_id: z.string()
    .min(1)
    .max(50)
    .describe(
      'Exact business order ID extracted from the user request, e.g. ORD-1001. Required to retrieve one order.'
    ),
};

const listOrdersInputSchema = {
  status: z.string()
    .max(50)
    .optional()
    .describe(
      'Optional exact order status filter, e.g. shipped, processing, or delivered. Omit when the user wants orders of any status.'
    ),

  limit: z.number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe(
      'Optional maximum number of order summaries to return. Must be an integer from 1 to 100. Default is 20.'
    ),

  offset: z.number()
    .int()
    .min(0)
    .max(100000)
    .optional()
    .describe(
      'Optional number of orders to skip before returning results, for pagination. Must be an integer of 0 or more. Default is 0.'
    ),
};

const createOrderInputSchema = {
  items: z.array(
    z.object({
      sku: z.string()
        .min(1)
        .max(50)
        .describe(
          // eslint-disable-next-line max-len
          'Exact product SKU resolved with search_products, e.g. SKU-001.'
        ),
      quantity: z.number()
        .int()
        .min(1)
        .max(999)
        .describe(
          'Whole number of units to order for this SKU, at least 1.'
        ),
    })
  )
    .min(1)
    .max(20)
    .describe(
      'One to twenty distinct order lines, each with an exact product SKU and a positive quantity.'
    ),
};

const listProductsInputSchema = {
  limit: z.number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe(
      'Optional maximum number of products to return. Must be an integer from 1 to 100. Default is 50.'
    ),
};

const checkStockInputSchema = {
  sku: z.string()
    .min(1)
    .max(50)
    .describe(
      'Exact product SKU, e.g. SKU-001. Use search_products first if the user only provides a product name or an uncertain SKU.'
    ),
};

const searchProductsInputSchema = {
  query: z.string()
    .min(1)
    .max(100)
    .describe(
      'Product full name, partial name, exact SKU, or partial SKU. Extract a concise search term from the user request, e.g. USB-C Hub, hub, or SKU-003.'
    ),

  limit: z.number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe(
      'Optional maximum number of matching products to return. Must be an integer from 1 to 50. Default is 10.'
    ),
};

const updateStockInputSchema = {
  sku: z.string()
    .min(1)
    .max(50)
    .describe(
      'Exact SKU of the product whose inventory must change, e.g. SKU-001. Use search_products first if the SKU is unknown.'
    ),

  quantity: z.number()
    .int()
    .refine((value) => value !== 0, {
      message: 'quantity must not be 0',
    })
    .describe(
      'Signed integer stock change, not final stock: positive adds units, negative removes units, and zero is invalid. Only call when the user explicitly requests a stock change.'
    ),
};

const registerInputSchema = {
  name: z.string()
    .min(1)
    .max(100)
    .describe(
      'Display name for the new account, e.g. "Aakash".'
    ),
  email: z.string()
    .min(3)
    .max(255)
    .describe(
      'Email address for the new account, e.g. aakash@example.com. Must be unique.'
    ),
  password: z.string()
    .min(8)
    .max(200)
    .describe(
      // eslint-disable-next-line max-len
      'Password at least 8 characters long containing at least one letter and one digit.'
    ),
};

const loginInputSchema = {
  email: z.string()
    .min(3)
    .max(255)
    .describe('Email of the account to log in.'),
  password: z.string()
    .min(1)
    .max(200)
    .describe('Password of the account.'),
};

const logoutInputSchema = {}; 

const whoamiInputSchema = {}; // This tool takes no arguments; it only reports the current session context.

// --------------------------------------------------
// Authorization guards
//
// Every protected handler starts with these. The context is built ONLY by
// the transport layer (stdio resolver or HTTP Bearer resolver) from a valid
// DB-backed session - never from tool arguments.
// --------------------------------------------------

function guardAuth(auth, context) { //aa function guardAuth() authentication check kare chhe.
  try {
    auth.requireAuth(context);
    return null;
  } catch (error) {
    if (error instanceof AuthError) {
      return errResult(
        'Authentication required: log in with the login tool, or configure MCP_AUTH_TOKEN for stdio clients, or send an Authorization: Bearer token over HTTP.'
      );
    }
    throw error;
  }
}

function guardAdmin(auth, context) {  // aa function guardAdmin() authorization check kare chhe ke user admin chhe ke nahi.
  try {
    auth.requireAdmin(context);
    return null;
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return errResult(error.message);
    }
    if (error instanceof AuthError) {
      return errResult(
        'Authentication required: log in with the login tool, or configure MCP_AUTH_TOKEN for stdio clients, or send an Authorization: Bearer token over HTTP.'
      );
    }
    throw error;
  }
}

// Safe reported error that never leaks totals/SQL/internals.

// --------------------------------------------------
// Tool handlers
// --------------------------------------------------

function createTools(pool, providedAuth) {
  const auth = providedAuth || createAuth(pool); 

  // Get one order and its line items.
  // Users: SQL enforces `user_id = own id`. Admins: any order.
  // Missing AND not-owned look identical ("Order not found") so the tool
  // never reveals whether another user's order exists (IDOR defense).
  async function getOrderHandler(args, context) { // args has a order
    const denied = guardAuth(auth, context); //
    if (denied) return denied;

    order_id = sanitizeString(args.order_id);

    const scope = auth.orderScope(context); 

    const params = [order_id]; 
    let sql = `
      SELECT id, order_id, customer_name, status, total_amount, created_at, user_id
      FROM orders
      WHERE order_id = $1
    `;
    if (scope.scope === 'own') {
      sql += ` AND user_id = $2`;
      params.push(scope.ownerUserId);
    }

    const orderResult = await pool.query(sql, params);

    if (orderResult.rows.length === 0) {
      return errResult(`Order not found: ${order_id}`);
    }

    const order = orderResult.rows[0];

    const itemsResult = await pool.query(
      `SELECT p.sku, p.name, oi.quantity, oi.unit_price
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1`,
      [order.id]
    );

    const response = {
      order_id: order.order_id,
      customer_name: order.customer_name,
      status: order.status,
      total_amount: order.total_amount,
      created_at: order.created_at,
      items: itemsResult.rows,
    };

    return okResult(JSON.stringify(response, null, 2));
  }

  // List orders. Ownership is applied in the SQL query itself. Users can
  // NEVER see other users' orders, no matter what status/limit/offset they
  // pass. Admins see everything, including legacy orders with owner NULL.
  async function listOrdersHandler(args, context) {
        // 1. Check whether user is logged in
        const denied = guardAuth(auth, context);
        if (denied) return denied;

        // 2. Decide which orders the user can see
        const scope = auth.orderScope(context);

        // 3. Get optional filters from user
        const maxRows = args.limit || 20;
        const skip = args.offset || 0;
        const cleanStatus = args.status ? sanitizeString(args.status) : null;

        // 4. Prepare SQL conditions
        const params = [];
        const where = [];

        // 5. Normal user can see only their own orders
        if (scope.scope === 'own') {
          params.push(scope.ownerUserId);
          where.push(`user_id = $${params.length}`);
        }

        // 6. If status is provided, filter by status too
        if (cleanStatus) {
          params.push(cleanStatus);
          where.push(`status = $${params.length}`);
        }

        // 7. Build SQL query
        const sql = `
          SELECT order_id, customer_name, status, total_amount, created_at
          FROM orders
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY created_at DESC, id DESC
          LIMIT ${Number(maxRows)} OFFSET ${Number(skip)}
        `;

        // 8. Execute query
        const result = await pool.query(sql, params);

        // 9. Return orders
        return okResult(JSON.stringify(result.rows, null, 2));
  }
  // Create an order for the authenticated user with transactional stock
  // reservation. Prices always come from the database, never from arguments.
  async function createOrderHandler(args, context) {
    const denied = guardAuth(auth, context);
    if (denied) return denied;

    // Merge duplicate SKUs and validate every line.
    const wanted = new Map();

    for (const item of args.items) {
      const sku = sanitizeString(item.sku);
      const qty = item.quantity;

      if (!sku) {
        return errResult('Each order line needs a product SKU.');
      }
      if (!Number.isInteger(qty) || qty < 1 || qty > 999) {
        return errResult('Each order line quantity must be an integer between 1 and 999.');
      }
      wanted.set(sku, (wanted.get(sku) || 0) + qty);
    }

    const skus = [...wanted.keys()];

    // arg.user_id (if a model or client sends one) is intentionally ignored:
    // the order always belongs to context.userId.

    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        // Lock the wanted products in a deterministic order so two concurrent
        // orders can not deadlock, then read trusted prices/stock.
        const locked = await client.query(
          `
          SELECT p.id, p.sku, p.name, p.price, p.stock_quantity
          FROM products p
          WHERE p.id IN (
            SELECT id FROM products
            WHERE sku = ANY($1::text[])
              AND is_active = TRUE
            ORDER BY id
          )
          ORDER BY p.id
          FOR UPDATE
          `,
          [skus]
        );

        const rows = new Map(locked.rows.map((row) => [row.sku, row]));
        const unknown = skus.filter((sku) => !rows.has(sku));

        if (unknown.length > 0) {
          await client.query('ROLLBACK');
          return errResult(`Product not found or inactive: ${unknown.join(', ')}`);
        }

        const shortfall = skus
          .filter((sku) => rows.get(sku).stock_quantity < wanted.get(sku))
          .map((sku) => `${sku} (requested ${wanted.get(sku)}, available ${rows.get(sku).stock_quantity})`);

        if (shortfall.length > 0) {
          await client.query('ROLLBACK');
          return errResult(`Insufficient stock: ${shortfall.join('; ')}`);
        }

        // Trusted total from DB prices.
        const total = skus.reduce(
          (sum, sku) => sum + Number(rows.get(sku).price) * wanted.get(sku),0);

        // Deduct stock with an in-SQL guard against overselling races.
        for (const sku of skus) {
          const updated = await client.query(
            `
            UPDATE products
            SET stock_quantity = stock_quantity - $2,
                updated_at = now()
            WHERE id = $1
              AND stock_quantity >= $2
            RETURNING stock_quantity
            `,
            [rows.get(sku).id, wanted.get(sku)]
          );

          if (updated.rows.length === 0) {
            await client.query('ROLLBACK');
            return errResult(`Insufficient stock: ${sku} (sold out during checkout)`);
          }
        }

        // Business order id: highest numeric suffix in existing ORD-nnn
        // ids plus 1. Unique-violation → retry the whole transaction.
        const nextId = await client.query(
          `
          SELECT COALESCE(
            MAX(NULLIF(regexp_replace(order_id, '\\D', '', 'g'), '')::bigint),
            1000
          ) + 1 AS next
          FROM orders
          `
        );

        const order_id = `ORD-${nextId.rows[0].next}`;

        const inserted = await client.query(
          `
          INSERT INTO orders (order_id, customer_name, status, total_amount, user_id)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id, order_id, status, total_amount, created_at
          `,
          [order_id, context.name, 'processing', total.toFixed(2), context.userId]
        );

        for (const sku of skus) {
          const row = rows.get(sku);
          await client.query(
            `
            INSERT INTO order_items (order_id, product_id, quantity, unit_price)
            VALUES ($1, $2, $3, $4)
            `,
            [inserted.rows[0].id, row.id, wanted.get(sku), row.price]
          );
        }

        await client.query('COMMIT');

        const response = {
          order_id: inserted.rows[0].order_id,
          status: inserted.rows[0].status,
          total_amount: inserted.rows[0].total_amount,
          created_at: inserted.rows[0].created_at,
          items: skus.map((sku) => ({
            sku,
            name: rows.get(sku).name,
            quantity: wanted.get(sku),
            unit_price: rows.get(sku).price,
          })),
        };

        return okResult(JSON.stringify(response, null, 2));
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_e) { /* connection may be broken */ }

        // Concurrent creators computed the same next order id: retry.
        if (error.code === '23505' && attempt < MAX_ATTEMPTS) {
          continue;
        }

        throw error;
      } finally {
        client.release();
      }
    }

    return errResult('Could not create the order due to a concurrency conflict. Please try again.');
  }

  // List active products with public information only.
  async function listProductsHandler(args, context) {
    const denied = guardAuth(auth, context);
    if (denied) return denied;

    const maxRows = args.limit || 50;

    const result = await pool.query(
      `
      SELECT sku, name, description, price, stock_quantity
      FROM products
      WHERE is_active = TRUE
      ORDER BY id
      LIMIT ${Number(maxRows)}
      `
    );

    return okResult(JSON.stringify(result.rows, null, 2));
  }

  
  // Check stock for an exact SKU (any authenticated user).
  async function checkStockHandler(args, context) { 
    const denied = guardAuth(auth, context);
    if (denied) return denied;

    const sku = sanitizeString(args.sku);

    const result = await pool.query(
      'SELECT sku, name, stock_quantity, is_active FROM products WHERE sku = $1',
      [sku]
    );

    if (result.rows.length === 0) {
      return errResult(`Product not found: ${sku}`);
    }

    return okResult(JSON.stringify(result.rows[0], null, 2));
  }

  // Search products by name or SKU (any authenticated user).
  async function searchProductsHandler(args, context) {
    const denied = guardAuth(auth, context);
    if (denied) return denied;

    const term = sanitizeString(args.query);
    const maxRows = args.limit || 10;

    if (!term) {
      return errResult('A product name or SKU is required.');
    }

    // Escape SQL LIKE wildcards in user input
    const escapeLike = (value) =>
      value.replace(/([\\%_])/g, '\\$1');

    const pattern = `%${escapeLike(term)}%`;

    let result = await pool.query(
      `SELECT sku, name, price, stock_quantity, is_active
       FROM products
       WHERE name ILIKE $1 OR sku ILIKE $1
       ORDER BY (LOWER(name) = LOWER($2)) DESC,
                (LOWER(sku) = LOWER($2)) DESC,
                name
       LIMIT ${Number(maxRows)}`,
      [pattern, term]
    );

    // Fallback: search individual words if the full phrase has no match
    if (result.rows.length === 0) {
      const words = term
        .split(/[^a-z0-9+#.-]+/i)
        .map((word) => word.replace(/^[.-]+|[.-]+$/g, ''))
        .filter((word) => word.length >= 3);

      if (words.length) {
        const wordPatterns = words.map(
          (word) => `%${escapeLike(word)}%`
        );

        result = await pool.query(
          `SELECT sku, name, price, stock_quantity, is_active
           FROM products
           WHERE name ILIKE ANY($1::text[])
              OR sku ILIKE ANY($1::text[])
           ORDER BY name
           LIMIT ${Number(maxRows)}`,
          [wordPatterns]
        );
      }
    }

    if (result.rows.length === 0) {
      return errResult(`Product not found: ${term}`);
    }

    return okResult(JSON.stringify(result.rows, null, 2));
  }

  // ADMIN-ONLY stock change with signed quantity.
  async function updateStockHandler(args, context) { 

    const denied = guardAdmin(auth, context);  //guardAdmin() function call kare chhe je check kare chhe ke user admin chhe ke nahi. jo user admin nathi to e permission denied error return kare chhe.
    if (denied) return denied;

    const sku = sanitizeString(args.sku);
    const quantity = args.quantity;

    const result = await pool.query(
      `UPDATE products
       SET stock_quantity = stock_quantity + $1,
           updated_at = now()
       WHERE sku = $2
         AND stock_quantity + $1 >= 0
       RETURNING sku, name, stock_quantity`,
      [quantity, sku]
    );

    if (result.rows.length === 0) {
      const exists = await pool.query(
        'SELECT stock_quantity FROM products WHERE sku = $1',
        [sku]
      );

      if (exists.rows.length === 0) {
        return errResult(`Product not found: ${sku}`);
      }

      return errResult(
        `Insufficient stock for ${sku}. Current: ${exists.rows[0].stock_quantity}, requested change: ${quantity}`
      );
    }

    return okResult(JSON.stringify(result.rows[0], null, 2));
  }

  // --------------------------------------------------
  // Authentication tools
  // --------------------------------------------------

  async function registerHandler(args, _context) {
    // Any role/user_id-like fields in args are ignored: registration always
    // produces a plain user via registerUser.
    try {
      await auth.registerUser({
        name: args.name,
        email: args.email,
        password: args.password,
      });

      return okResult(
        'Account created. Role: user. Now ask to log in with your new email and password to get a session token.'
      );
    } catch (error) {
      if (error instanceof AuthError) {
        return errResult(error.message);
      }
      throw error;
    }
  }

  async function loginHandler(args, _context) {
    try {
      const user = await auth.loginUser({
        email: args.email,
        password: args.password,
      });

      const { token, expiresAt } = await auth.createSession(user.id);

      // stdio-only convenience: remember the verified session in-process so
      // this same client's next tool calls are authenticated. Never logged.
      sessionState.rawToken = token;

      return okResult(JSON.stringify({
        logged_in: true,
        user: { name: user.name, email: user.email, role: user.role },
        session_token: token,
        expires_at: expiresAt,
        note: 'This client session is now authenticated. For stdio clients such as Claude Desktop, you can alternatively put this token as MCP_AUTH_TOKEN in the client env config. Keep the token private.',
      }, null, 2));
    } catch (error) {
      if (error instanceof AuthError) {
        return errResult(error.message);
      }
      throw error;
    }
  }

  async function logoutHandler(_args, context) {
    const denied = guardAuth(auth, context);
    if (denied) return denied;

    // The raw token for the current session: an in-process login token or
    // the server-configured stdio token.
    const rawToken = sessionState.rawToken || process.env.MCP_AUTH_TOKEN;

    try {
      const ended = await auth.expireSession(context, rawToken);
      sessionState.rawToken = null;

      return okResult(
        ended
          ? 'Logged out. This session token was revoked; protected tools now require a fresh login.'
          : 'No active session token available to revoke locally, but this client is no longer authenticated.'
      );
    } catch (error) {
      if (error instanceof AuthError) {
        return errResult(error.message);
      }
      throw error;
    }
  }

  async function whoamiHandler(_args, context) {
    const denied = guardAuth(auth, context);
    if (denied) return denied;

    return okResult(JSON.stringify({
      user_id: context.userId,
      name: context.name,
      email: context.email,
      role: context.role,
      order_access: context.role === 'admin' ? 'all orders' : 'own orders only',
      stock_update: context.role === 'admin' ? 'allowed' : 'denied',
    }, null, 2));
  }

  // Raw token of the in-process session (stdio resolver fallback).
  function getActiveTokenRaw() {
    return sessionState.rawToken;
  }

  // Clear the in-process session without touching the database (used by
  // transports that never want the stdio session carryover).
  function clearActiveToken() {
    sessionState.rawToken = null;
  }

  // Expose descriptions, schemas, and handlers
  return {
    auth,

    getOrderDescription,
    getOrderInputSchema,
    getOrderHandler,

    listOrdersDescription,
    listOrdersInputSchema,
    listOrdersHandler,

    createOrderDescription,
    createOrderInputSchema,
    createOrderHandler,

    listProductsDescription,
    listProductsInputSchema,
    listProductsHandler,

    checkStockDescription,
    checkStockInputSchema,
    checkStockHandler,

    searchProductsDescription,
    searchProductsInputSchema,
    searchProductsHandler,

    updateStockDescription,
    updateStockInputSchema,
    updateStockHandler,

    registerDescription,
    registerInputSchema,
    registerHandler,

    loginDescription,
    loginInputSchema,
    loginHandler,

    logoutDescription,
    logoutInputSchema,
    logoutHandler,

    whoamiDescription,
    whoamiInputSchema,
    whoamiHandler,

    getActiveTokenRaw,
    clearActiveToken,
  };
}

module.exports = {
  createTools,
  sanitizeString,

  getOrderDescription,
  listOrdersDescription,
  checkStockDescription,
  searchProductsDescription,
  updateStockDescription,
};
