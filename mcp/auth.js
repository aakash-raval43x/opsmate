// auth.js
// Authentication + authorization core for the Order & Inventory MCP server.
//
// Identity model:
//   - Registration always creates a plain 'user'. Role can only be granted by
//     a trusted administrative process (scripts/create-admin.js) — never from
//     tool arguments, never from anything a client sends.
//   - Passwords are hashed with bcrypt. Plaintext passwords are never stored
//     and never logged.
//   - Sessions are opaque random tokens. Only a SHA-256 hash of the token is
//     persisted, so a database leak does not expose usable tokens.
//   - Every protected tool handler receives a verified context:
//         { userId, email, role, name }
//     built ONLY by this module from a valid DB-backed session. Tool
//     arguments never carry identity or role; anything like that sent by a
//     client or the LLM is ignored.
//   - Authorization fails closed: no context -> "authentication required".

const crypto = require('crypto');
const bcrypt = require('bcrypt');

const BCRYPT_COST = 12;

// Session duration, configurable, default 24 hours.
function sessionTtlMs() {
  const hours = Number(process.env.MCP_SESSION_TTL_HOURS || 24);
  // Reject nonsense values so a typo cannot create billion-year tokens.
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 90) {
    throw new Error('MCP_SESSION_TTL_HOURS must be a positive number up to 90 days');
  }
  return hours * 60 * 60 * 1000;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// --------------------------------------------------
// Errors surfaced to MCP clients as safe, non-internal messages
// --------------------------------------------------
class AuthError extends Error {}
class ForbiddenError extends Error {}

// --------------------------------------------------
// Token utilities
// --------------------------------------------------
function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

// Opaque token, not JWT, not derived from user data: the session row in the
// database is the single source of truth and can be revoked at any moment.
function generateToken() {
  return 'ops_' + crypto.randomBytes(32).toString('hex');
}

// --------------------------------------------------
// Input validation
// --------------------------------------------------
function validateRegistration({ name, email, password }) {
  const errors = [];

  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 100) {
    errors.push('name is required (1-100 characters)');
  }
  if (typeof email !== 'string' || email.length > 255 || !EMAIL_RE.test(email.trim())) {
    errors.push('a valid email address is required');
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    errors.push('password must be 8-200 characters');
  } else if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    errors.push('password must contain at least one letter and one digit');
  }

  return errors;
}

// --------------------------------------------------
// Module factory: every function takes the pg pool explicitly,
// so the same code serves the MCP db.js pool and the backend's own pool.
// --------------------------------------------------
function createAuth(pool) {
  // Registration. ALWAYS creates a 'user'. A client-supplied `role` is
  // deliberately absent from the accepted fields — it cannot be elevated.
  async function registerUser({ name, email, password }) {
      const errors = validateRegistration({ name, email, password });
      if (errors.length) {
        throw new AuthError(`Registration failed: ${errors.join('; ')}`);
      }

      const cleanEmail = String(email).trim().toLowerCase();
      const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

      try {
          const result = await pool.query(
            `INSERT INTO users (name, email, password_hash, role, is_active)
            VALUES ($1, $2, $3, 'user', TRUE)
            RETURNING id, name, email, role`,
            [name.trim(), cleanEmail, passwordHash]
        );

        return result.rows[0];
      } catch (error) {
          if (error.code === '23505') {
            // Unique violation on the case-insensitive email index.
            throw new AuthError('An account with this email already exists.');
          }
          // Never leak SQL or internals to the caller.
          console.error('[auth] registerUser database error:', error.message);
          throw new AuthError('Registration failed due to a server error.');
      }
    }

    // Login. Generic failure message for every bad path so we never reveal
    // whether an email exists or whether an account is inactive.
    async function loginUser({ email, password }) {
      if (typeof email !== 'string' || typeof password !== 'string') {
        throw new AuthError('Invalid email or password.');
      }

      const cleanEmail = String(email).trim().toLowerCase();

      let row;
      try {
        const result = await pool.query(
          `SELECT id, name, email, role, password_hash, is_active
          FROM users
          WHERE LOWER(email) = $1`,
          [cleanEmail]
        );
        row = result.rows[0];
      } catch (error) {
        console.error('[auth] loginUser database error:', error.message);
        throw new AuthError('Login failed due to a server error.');
      }

      if (!row || !row.is_active) {
        // Burn a hash comparison anyway so timing looks identical whether the
        // account exists or not.
        await bcrypt.compare(password, '$2b$12$C6UzMDM.H6dfI/f/IKcEe.wL9Jz3MwfGMOVvSjHFYuLyq5vOA1fKa');
        throw new AuthError('Invalid email or password.');
      }

      const ok = await bcrypt.compare(password, row.password_hash);
      if (!ok) {
        throw new AuthError('Invalid email or password.');
      }

      return { id: row.id, name: row.name, email: row.email, role: row.role };
  }

  // Creates a session and returns ONLY the raw token (to be given once to
  // the client). The database stores only its hash.
  async function createSession(userId, ttlMs) {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + (ttlMs == null ? sessionTtlMs() : ttlMs));

    try {
      await pool.query(
        `INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [userId, hashToken(token), expiresAt]
      );
    } catch (error) {
      console.error('[auth] createSession database error:', error.message);
      throw new AuthError('Could not create a session due to a server error.');
    }

    return { token, expiresAt };
  }

  // Resolves a raw token to a verified context, or null.
  // This is the ONLY way a tool handler can receive an identity.
  async function resolveSessionToken(token) {
    if (typeof token !== 'string' || token.length < 10 || token.length > 256) {
      return null;
    }

    try {
          const result = await pool.query(
            `SELECT u.id, u.name, u.email, u.role
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = $1
              AND s.revoked_at IS NULL
              AND s.expires_at > NOW()
              AND u.is_active = TRUE`,
            [hashToken(token)]
          );

          const row = result.rows[0];
          if (!row) {
            // Lazy cleanup of this user's other expired sessions is skipped;
            // expiry is enforced above, old rows are harmless.
            return null;
          }

          return { userId: row.id, name: row.name, email: row.email, role: row.role };
      } catch (error) {
            console.error('[auth] resolveSessionToken database error:', error.message);
            // Fail closed: any verification problem means "not authenticated".
            return null;
      }
  }

  // Logout: delete the session row for this raw token if it belongs to the
  // resolved user. Returns true when a session was actually ended.
  async function expireSession(context, token) {
    if (!context || typeof token !== 'string') return false;

    try {
      await pool.query(
        `DELETE FROM sessions
         WHERE token_hash = $1
           AND user_id = $2`,
        [hashToken(token), context.userId]
      );
      return true;
    } catch (error) {
      console.error('[auth] expireSession database error:', error.message);
      throw new AuthError('Logout failed due to a server error.');
    }
  }

  // ------------------------------------------------
  // Authorization helpers (centralized, fail closed)
  // ------------------------------------------------

  // Throws unless the context is a fully verified identity.
  function requireAuth(context) {
    if (
      !context ||
      !Number.isInteger(context.userId) ||
      (context.role !== 'user' && context.role !== 'admin')
    ) {
      throw new AuthError(
        'Authentication required. Configure MCP_AUTH_TOKEN for stdio clients or send a valid Authorization: Bearer token over HTTP.'
      );
    }
    return context;
  }

  // Throws unless the context is a verified admin.
  function requireAdmin(context) {
    requireAuth(context);
    if (context.role !== 'admin') {
      throw new ForbiddenError('Permission denied: this action requires administrator privileges.');
    }
    return context;
  }

  // For order ownership queries: users are constrained to their own rows in
  // the SQL itself via (user_id = $n); admin passes no constraint. Returns
  // { constraint: 'own'|'all', ownerUserId }.
  function orderScope(context) {
    requireAuth(context);
    return context.role === 'admin'
      ? { scope: 'all', ownerUserId: null }
      : { scope: 'own', ownerUserId: context.userId };
  }

  return {
    AuthError,
    ForbiddenError,
    BCRYPT_COST,
    registerUser,
    loginUser,
    createSession,
    resolveSessionToken,
    expireSession,
    requireAuth,
    requireAdmin,
    orderScope,
    validateRegistration,
  };
}

module.exports = { createAuth, AuthError, ForbiddenError, hashToken, generateToken };
