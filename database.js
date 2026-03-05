// database.js
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

// Render free plan me disk reset ho sakta hai.
// Local me ye file project ke andar banegi.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "rentspot.db");

const db = new sqlite3.Database(DB_PATH);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
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

// ---- Schema + Migration ----
async function initSchema() {
  // users
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // properties (PGs)
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
      whatsapp TEXT,
      location_url TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // reviews
  await run(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER NOT NULL,
      user_id INTEGER,
      user_name TEXT,
      rating INTEGER NOT NULL,
      comment TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(property_id) REFERENCES properties(id)
    )
  `);

  // bookings
  await run(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      user_name TEXT,
      user_email TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(property_id) REFERENCES properties(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  // notifications (simple)
  await run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ---- Migration safety: old DB me password_hash column missing ho sakta hai ----
  // Agar tumhare old users table me 'password' tha ya password_hash missing tha
  // to ye add ho jayega.
  try {
    const cols = await all(`PRAGMA table_info(users)`);
    const hasPasswordHash = cols.some(c => c.name === "password_hash");

    if (!hasPasswordHash) {
      await run(`ALTER TABLE users ADD COLUMN password_hash TEXT`);
      // NOTE: old users ke liye password_hash null rahega.
      // Tumhe old users ko re-register karna padega.
    }
  } catch (e) {
    // ignore migration errors
  }
}

module.exports = {
  db,
  run,
  get,
  all,
  initSchema,
  DB_PATH,
};