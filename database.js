// database.js (SQLite) - Fresh + Auto Migration + Works with server.js
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, "rentspot.db");
const db = new sqlite3.Database(DB_PATH);

// Promisified helpers
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this); // has lastID
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

// DB schema init + migrations
async function initSchema() {
  // USERS table (new schema)
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      role TEXT DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // MIGRATION: add password_hash if missing
  const userCols = await all(`PRAGMA table_info(users)`);
  const hasPasswordHash = userCols.some((c) => c.name === "password_hash");

  if (!hasPasswordHash) {
    await run(`ALTER TABLE users ADD COLUMN password_hash TEXT`);
  }

  // Optional: if old column "password" exists, copy it into password_hash (best effort)
  const hasPasswordCol = userCols.some((c) => c.name === "password");
  if (hasPasswordCol) {
    try {
      await run(`UPDATE users SET password_hash = password WHERE password_hash IS NULL`);
    } catch (e) {
      // ignore
    }
  }

  // PGs
  await run(`
    CREATE TABLE IF NOT EXISTS pgs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      city TEXT NOT NULL,
      address TEXT,
      price INTEGER NOT NULL,
      phone TEXT,
      description TEXT,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // PG photos (multiple)
  await run(`
    CREATE TABLE IF NOT EXISTS pg_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pg_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Reviews
  await run(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pg_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Bookings
  await run(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pg_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      message TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Notifications
  await run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient TEXT NOT NULL,   -- user email OR 'admin'
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      link TEXT,
      is_read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Useful indexes
  await run(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_reviews_pg ON reviews(pg_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient)`);
}

module.exports = {
  db,
  run,
  get,
  all,
  initSchema
};