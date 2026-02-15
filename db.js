const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

const db = new Database(path.join(__dirname, "cage.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY COLLATE NOCASE,
    stripe_customer_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS magic_links (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    expires_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS usage (
    email TEXT NOT NULL COLLATE NOCASE,
    date TEXT NOT NULL,
    count INTEGER DEFAULT 0,
    PRIMARY KEY (email, date)
  );
`);

const stmt = {
  getUser: db.prepare("SELECT * FROM users WHERE email = ?"),
  createUser: db.prepare("INSERT OR IGNORE INTO users (email) VALUES (?)"),
  linkStripe: db.prepare("UPDATE users SET stripe_customer_id = ? WHERE email = ?"),
  getUserByStripe: db.prepare("SELECT * FROM users WHERE stripe_customer_id = ?"),

  createMagicLink: db.prepare(
    "INSERT INTO magic_links (token, email, expires_at) VALUES (?, ?, ?)"
  ),
  getMagicLink: db.prepare(
    "SELECT * FROM magic_links WHERE token = ? AND used = 0 AND expires_at > ?"
  ),
  useMagicLink: db.prepare("UPDATE magic_links SET used = 1 WHERE token = ?"),

  createSession: db.prepare(
    "INSERT INTO sessions (token, email, expires_at) VALUES (?, ?, ?)"
  ),
  getSession: db.prepare(
    "SELECT * FROM sessions WHERE token = ? AND expires_at > ?"
  ),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token = ?"),
  deleteUserSessions: db.prepare("DELETE FROM sessions WHERE email = ?"),
  deleteExpiredSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
  deleteExpiredLinks: db.prepare("DELETE FROM magic_links WHERE expires_at <= ?"),

  getUsage: db.prepare("SELECT count FROM usage WHERE email = ? AND date = ?"),
  incUsage: db.prepare(`
    INSERT INTO usage (email, date, count) VALUES (?, ?, 1)
    ON CONFLICT(email, date) DO UPDATE SET count = count + 1
  `),
};

function genToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function today() {
  return new Date().toISOString().split("T")[0];
}

// --- Magic links ---

function createMagicLink(email) {
  const token = genToken();
  const expiresAt = Date.now() + 15 * 60 * 1000; // 15 min
  const lower = email.toLowerCase().trim();
  stmt.createUser.run(lower);
  stmt.createMagicLink.run(token, lower, expiresAt);
  return token;
}

function verifyMagicLink(token) {
  const row = stmt.getMagicLink.get(token, Date.now());
  if (!row) return null;
  stmt.useMagicLink.run(token);
  return row.email;
}

// --- Sessions ---

function createSession(email) {
  const token = genToken();
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
  stmt.createSession.run(token, email.toLowerCase().trim(), expiresAt);
  return token;
}

function getSessionUser(token) {
  if (!token) return null;
  const row = stmt.getSession.get(token, Date.now());
  return row ? row.email : null;
}

function deleteSession(token) {
  if (token) stmt.deleteSession.run(token);
}

// --- Users ---

function getUser(email) {
  return stmt.getUser.get(email.toLowerCase().trim()) || null;
}

function linkStripeCustomer(email, customerId) {
  const lower = email.toLowerCase().trim();
  stmt.createUser.run(lower);
  stmt.linkStripe.run(customerId, lower);
}

function getUserByStripe(customerId) {
  return stmt.getUserByStripe.get(customerId) || null;
}

// --- Usage ---

function getUsageCount(email) {
  const row = stmt.getUsage.get(email.toLowerCase().trim(), today());
  return row ? row.count : 0;
}

function incrementUsage(email) {
  stmt.incUsage.run(email.toLowerCase().trim(), today());
}

// --- Cleanup ---

function cleanup() {
  const now = Date.now();
  db.exec(
    `DELETE FROM sessions WHERE expires_at <= ${now};
     DELETE FROM magic_links WHERE expires_at <= ${now};`
  );
}

setInterval(cleanup, 60 * 60 * 1000);

module.exports = {
  createMagicLink,
  verifyMagicLink,
  createSession,
  getSessionUser,
  deleteSession,
  getUser,
  linkStripeCustomer,
  getUserByStripe,
  getUsageCount,
  incrementUsage,
};
