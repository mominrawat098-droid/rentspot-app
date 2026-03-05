// database.js
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "rentspot.db");
const db = new sqlite3.Database(DB_FILE);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
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

// Check if a column exists in a table
async function columnExists(tableName, columnName) {
  const rows = await all(`PRAGMA table_info(${tableName})`);
  return rows.some((r) => r.name === columnName);
}

async function initSchema() {
  // users table
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      role TEXT DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // In case old table existed without password_hash
  const hasPasswordHash = await columnExists("users", "password_hash");
  if (!hasPasswordHash) {
    await run(`ALTER TABLE users ADD COLUMN password_hash TEXT`);
  }

  // optional: if old column 'password' exists, you can keep it or ignore
  // but our code uses password_hash only.
}

module.exports = {
  db,
  run,
  get,
  all,
  initSchema,
  DB_FILE,
};