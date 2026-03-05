// database.js (PASTE-READY)
// SQLite helpers + schema init for RentSpot

const path = require("path");
const sqlite3 = require("sqlite3").verbose();

// Use file-based sqlite db
// Render: local disk can reset on redeploy/restart (free plan), but works for demo/testing.
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "rentspot.db");

const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) console.error("❌ SQLite open error:", err);
  else console.log("✅ SQLite connected:", DB_FILE);
});

// ---------- Helpers ----------
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

// ---------- Schema Init ----------
async function tableExists(tableName) {
  const row = await get(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    [tableName]
  );
  return !!row;
}

async function columnExists(tableName, columnName) {
  const rows = await all(`PRAGMA table_info(${tableName})`);
  return rows.some((c) => c.name === columnName);
}

async function initSchema() {
  // USERS
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // In case old DB exists without password_hash
  const hasPasswordHash = await columnExists("users", "password_hash");
  if (!hasPasswordHash) {
    await run(`ALTER TABLE users ADD COLUMN password_hash TEXT`);
    console.log("✅ Added missing column: users.password_hash");
  }

  // If old DB had "password" column and password_hash is empty,
  // we will NOT auto-migrate because we can't hash plaintext safely if already hashed/unknown.
  // You can delete db to reset if needed.

  // PROPERTIES
  await run(`
    CREATE TABLE IF NOT EXISTS properties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      city TEXT,
      address TEXT,
      price INTEGER DEFAULT 0,
      description TEXT,
      image TEXT,
      owner_phone TEXT,
      location_url TEXT,
      created_by INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // BOOKINGS
  await run(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      property_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // REVIEWS
  await run(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      property_id INTEGER NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // NOTIFICATIONS
  await run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      admin_only INTEGER DEFAULT 0,
      title TEXT,
      message TEXT,
      is_read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("✅ All tables ready");
}

module.exports = {
  db,
  run,
  get,
  all,
  initSchema,
};