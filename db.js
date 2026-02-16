const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

// Use DB_PATH env var for persistent disk on Render, fall back to app directory
const dbPath = process.env.DB_PATH || path.join(__dirname, "cage.db");
const db = new Database(dbPath);
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

  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL COLLATE NOCASE,
    source_url TEXT NOT NULL,
    title TEXT,
    byline TEXT,
    site_name TEXT,
    excerpt TEXT,
    text_content TEXT,
    article_date TEXT,
    caged_at TEXT DEFAULT (datetime('now')),
    UNIQUE(email, source_url)
  );
`);

const stmt = {
  getUser: db.prepare("SELECT * FROM users WHERE email = ?"),
  createUser: db.prepare("INSERT OR IGNORE INTO users (email) VALUES (?)"),
  linkStripe: db.prepare("UPDATE users SET stripe_customer_id = ? WHERE email = ?"),
  getUserByStripe: db.prepare("SELECT * FROM users WHERE stripe_customer_id = ?"),
  getStripeCustomerIds: db.prepare("SELECT stripe_customer_id FROM users WHERE stripe_customer_id IS NOT NULL"),

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

  saveArticle: db.prepare(`
    INSERT INTO articles (email, source_url, title, byline, site_name, excerpt, text_content, article_date, caged_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email, source_url) DO UPDATE SET
      title = excluded.title,
      byline = excluded.byline,
      site_name = excluded.site_name,
      excerpt = excluded.excerpt,
      text_content = excluded.text_content,
      article_date = excluded.article_date,
      caged_at = excluded.caged_at
  `),
  getArticles: db.prepare("SELECT * FROM articles WHERE email = ? ORDER BY caged_at DESC LIMIT 200"),
  deleteArticle: db.prepare("DELETE FROM articles WHERE id = ? AND email = ?"),
  deleteAllArticles: db.prepare("DELETE FROM articles WHERE email = ?"),
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

function getStripeCustomerIds() {
  return stmt.getStripeCustomerIds.all().map((r) => r.stripe_customer_id);
}

// --- Usage ---

function getUsageCount(email) {
  const row = stmt.getUsage.get(email.toLowerCase().trim(), today());
  return row ? row.count : 0;
}

function incrementUsage(email) {
  stmt.incUsage.run(email.toLowerCase().trim(), today());
}

// --- Articles (cloud history for Pro) ---

function saveArticle(email, article) {
  const lower = email.toLowerCase().trim();
  stmt.saveArticle.run(
    lower,
    article.sourceUrl || "",
    article.title || null,
    article.byline || null,
    article.siteName || null,
    article.excerpt || null,
    article.textContent || null,
    article.articleDate || null,
    article.cagedAt || new Date().toISOString()
  );
}

function getArticles(email) {
  return stmt.getArticles.all(email.toLowerCase().trim());
}

function deleteArticle(id, email) {
  return stmt.deleteArticle.run(id, email.toLowerCase().trim());
}

function deleteAllArticles(email) {
  return stmt.deleteAllArticles.run(email.toLowerCase().trim());
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
  getStripeCustomerIds,
  getUsageCount,
  incrementUsage,
  saveArticle,
  getArticles,
  deleteArticle,
  deleteAllArticles,
};
