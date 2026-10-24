// scripts/create-admin.js
// TRUSTED ADMINISTRATIVE PROCESS
//
// Public MCP registration can only ever create a 'user' role. This offline
// script is the ONLY supported way to create an administrator or promote an
// existing account to admin.
//
// Usage:
//   ADMIN_PASSWORD='....' node scripts/create-admin.js --name "Ops Admin" --email admin@example.com            # new admin
//   ADMIN_PASSWORD='....' node scripts/create-admin.js --email user@example.com --promote                       # promote existing user
//   ADMIN_PASSWORD='....' node scripts/create-admin.js --email admin@example.com --token --ttl-days 365         # also print a session token
//
// The admin password is read from the ADMIN_PASSWORD environment variable.
// It never becomes a command line argument and is never printed or logged.

require('dotenv').config({ path: require('path').join(require('path').join(__dirname, '..'), '.env') });

const readline = require('readline');
const { createAuth, AuthError } = require('../auth');
const pool = require('../db');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--promote') args.promote = true;
    else if (arg === '--token') args.token = true;
    else if (arg === '--ttl-days') args.ttlDays = Number(argv[++i]);
    else if (arg === '--name') args.name = argv[++i];
    else if (arg === '--email') args.email = argv[++i];
  }
  return args;
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.email) {
    process.stderr.write('Usage: ADMIN_PASSWORD=... node scripts/create-admin.js --email <email> [--name "Name"] [--promote] [--token] [--ttl-days N]\n');
    process.exitCode = 1;
    return;
  }

  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    process.stderr.write('ADMIN_PASSWORD environment variable is required (it is never stored in code). Exiting.\n');
    process.exitCode = 1;
    return;
  }

  const auth = createAuth(pool);
  const email = String(args.email).trim().toLowerCase();

  let user;

  const existing = await pool.query(
    'SELECT id, name, email, role FROM users WHERE LOWER(email) = $1',
    [email]
  );

  if (existing.rows.length > 0 && !args.promote) {
    const proceed = await confirm(
      `Account ${email} already exists (role: ${existing.rows[0].role}). Reset its password and make it admin? Type y to confirm: `
    );
    if (!proceed) return;
    user = await resetPasswordAndMakeAdmin(auth, existing.rows[0].id);
  } else if (existing.rows.length > 0) {
    const proceed = await confirm(`Promote ${email} to admin? Type y to confirm: `);
    if (!proceed) return;
    await pool.query(
      "UPDATE users SET role = 'admin', is_active = TRUE WHERE id = $1 AND role = 'user'",
      [existing.rows[0].id]
    );
    user = (await pool.query('SELECT id, name, email, role FROM users WHERE id = $1', [existing.rows[0].id])).rows[0];
  } else {
    if (args.promote) {
      process.stderr.write(`No account found for ${email}; use without --promote to create it. Exiting.\n`);
      process.exitCode = 1;
      return;
    }
    user = await auth.registerUser({
      name: args.name || 'Admin',
      email,
      password,
    });
    await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [user.id]);
    user = (await pool.query('SELECT id, name, email, role FROM users WHERE id = $1', [user.id])).rows[0];
  }

  process.stderr.write(
    `Admin ready: id=${user.id} name=${user.name} email=${user.email} role=${user.role}\n`
  );

  if (args.token) {
    const { token, expiresAt } = await auth.createSession(user.id, args.ttlDays ? args.ttlDays * 24 * 3600 * 1000 : undefined);
    // The token goes to STDOUT only, so it can be piped/captured without
    // mixing it into log lines.
    process.stdout.write(`MCP_AUTH_TOKEN=${token}\n`);
    process.stderr.write(`Session expires: ${expiresAt}\n`);
    process.stderr.write('Put this token in the client config env (stdio) or HTTP Authorization header.\n');
  }

  await pool.end();
}

async function resetPasswordAndMakeAdmin(auth, userId) {
  const password = process.env.ADMIN_PASSWORD;
  const hashed = await require('bcrypt').hash(
    password,
    auth.BCRYPT_COST || 12
  );
  await pool.query(
    "UPDATE users SET role = 'admin', is_active = TRUE, password_hash = $2 WHERE id = $1",
    [userId, hashed]
  );
  return (await pool.query('SELECT id, name, email, role FROM users WHERE id = $1', [userId])).rows[0];
}

main().catch(async (error) => {
  process.stderr.write(
    `create-admin failed: ${error && error.message ? error.message : String(error)}\n`
  );
  try { await pool.end(); } catch (_e) { /* ignore */ }
  process.exitCode = 1;
});
